"""What a "Try it" run needs beyond its conversation: the draft, kept in Redis (plan 40).

The agent builder's trial chat runs the draft **as it is now**, uncommitted, so
the definition cannot be loaded from the agents service's database the way a
saved agent's is. The start request stashes it here under
``trial:draft:{run_id}`` and the detached run reads it back, then sends it
inline (``definition``) on the ``/stream`` call and on every ``/resume`` leg.

A separate module from :mod:`utils.agent_trials` because the run module reads
it, and the trial start imports the run module.

* :class:`TrialDraft` — the stash: the definition, the draft's Approvals
  choices, and whether the trial is of an agent that already exists.
* :class:`TrialAgent` — the stand-in for an agent row when the draft was never
  created: what ``_run`` and the start flow read off an agent (slug, name,
  icon, owner, type), with no id, so nothing points at a row that is not there.
* :func:`overlay_approvals` — the draft's Approvals choices over the saved
  tool rows, for this run only.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

from redis import asyncio as aioredis
from redis.exceptions import RedisError

from core.cache import create_redis_client
from core.logging import get_logger
from core.settings import settings

logger = get_logger(__name__)


def _key(run_id: str) -> str:
    return f"trial:draft:{run_id}"


@dataclass(frozen=True)
class TrialAgent:
    """A never-created draft, standing in for an ``AgentTable`` row.

    ``id`` is ``None`` on purpose: the run's message and the conversation then
    record no agent (the trial CHECK allows exactly that), and the usage
    rollups key the answer by the draft's name. ``owner_user_id`` is the caller
    — a draft can only be the caller's — which also passes the run's ownership
    check and makes the agents service resolve it as a user agent.
    """

    slug: str
    name: str
    owner_user_id: str
    icon: str = ""
    description: str = ""
    id: None = None
    version: None = None
    type: str = "deep agent"
    is_active: bool = True

    @property
    def kind(self) -> str:
        return "custom"


@dataclass(frozen=True)
class TrialDraft:
    """One trial run's draft as stashed at start.

    ``definition`` is ``{spec, files}`` exactly as the builder sent it (the
    ``CustomAgentWrite`` shape the agents service validates). ``approvals``
    maps a tool key to the draft's choice — ``True``/``False`` to gate or not,
    ``None`` to follow the baseline. ``existing`` says the trial is of a saved
    agent (its row is the run's agent; memory is real), not a new draft.
    """

    definition: dict[str, Any]
    approvals: dict[str, bool | None] = field(default_factory=dict)
    existing: bool = False

    @property
    def spec(self) -> dict[str, Any]:
        spec = self.definition.get("spec")
        return spec if isinstance(spec, dict) else {}

    def agent_for(self, user_id: str) -> TrialAgent:
        """The stand-in agent for a draft with no row."""
        spec = self.spec
        return TrialAgent(
            slug=str(spec.get("slug") or ""),
            name=str(spec.get("name") or spec.get("slug") or "Draft agent"),
            owner_user_id=user_id,
            icon=str(spec.get("icon") or ""),
            description=str(spec.get("description") or ""),
        )

    def to_json(self) -> str:
        return json.dumps(
            {"definition": self.definition, "approvals": self.approvals, "existing": self.existing},
            ensure_ascii=False,
            separators=(",", ":"),
        )

    @classmethod
    def from_json(cls, raw: str) -> "TrialDraft | None":
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("definition"), dict):
            return None
        approvals = data.get("approvals") if isinstance(data.get("approvals"), dict) else {}
        return cls(
            definition=data["definition"],
            approvals={str(k): (v if isinstance(v, bool) else None) for k, v in approvals.items()},
            existing=bool(data.get("existing")),
        )


def overlay_approvals(tool_config: dict[str, Any], approvals: dict[str, bool | None]) -> dict[str, Any]:
    """The saved tool config with the draft's Approvals choices on top.

    A ``True``/``False`` choice replaces the saved one; ``None`` drops it, so
    the tool follows the draft's own baseline. Locked gates are merged by the
    runtime after every user choice, so no choice here can open one. Nothing is
    written back: the overlay lives on this run's config only.
    """
    merged = dict(tool_config.get("approvals") or {})
    for key, value in approvals.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = bool(value)
    return {
        "enabled": list(tool_config.get("enabled") or []),
        "disabled": list(tool_config.get("disabled") or []),
        "approvals": dict(sorted(merged.items())),
    }


class TrialDraftStore:
    """``trial:draft:{run_id}`` on one lazily created client."""

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._guard = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._guard:
            if self._client is None:
                self._client = create_redis_client()
        return self._client

    async def put(self, run_id: str, draft: TrialDraft) -> None:
        """Stash the draft for the run. Redis errors propagate: a trial run
        without its draft cannot start, so the start must fail instead."""
        client = await self._get_client()
        await client.set(_key(run_id), draft.to_json(), ex=settings.agent_trial.draft_ttl_seconds)

    async def get(self, run_id: str) -> TrialDraft | None:
        """The run's draft, or ``None`` when it expired or never was."""
        client = await self._get_client()
        raw = await client.get(_key(run_id))
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return TrialDraft.from_json(raw)

    async def delete(self, run_id: str) -> None:
        """Drop the stash once the run holds it (best effort — it expires anyway)."""
        try:
            client = await self._get_client()
            await client.delete(_key(run_id))
        except RedisError:
            logger.warning("trial_draft_delete_failed", "Could not drop a trial draft", exc_info=True, run_id=run_id)


trial_drafts = TrialDraftStore()
