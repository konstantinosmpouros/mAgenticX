"""Rebuild a user's authored workspace on this volume from ``chat_db``.

``chat_db`` is the source of truth for custom agents and custom skills; the
volume is the copy the *runtime* reads. Normal operation keeps them in step
because every save writes both. This module handles the case that operation
does not cover: **the volume is empty or incomplete** — a fresh container, a
wiped volume, or a second replica that has never seen this user.

Deliberately additive. It writes what is missing and never deletes: a folder
present here but absent in ``chat_db`` is more likely to be content that
pre-dates the store (and is still being adopted lazily on read) than something
that should be removed. Destroying it on a boot race would be unrecoverable,
whereas a stale extra folder is merely untidy.

Runs as a background task so a bridge that is slow or still starting cannot
block this service from serving. It retries, then gives up quietly — the volume
is only *stale*, not broken, and the next boot tries again.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from runtime.filesystem import layout
from runtime.skill_registry.user_registry import (
    add_custom_to_user,
    add_global_to_user,
    assign_user_skill_to_agent,
    read_user_manifest,
)
from runtime.abstractions import AgentSpec
from runtime.abstractions.user_agents import write_user_agent
from schema import AgentFile, CustomSkillCreate, SkillFile

logger = get_logger(__name__)


def _base_url() -> str:
    return settings.bridge.base_url.rstrip("/")


async def _get(client: httpx.AsyncClient, path: str) -> Any:
    resp = await client.get(f"{_base_url()}{path}", headers=internal_service_headers(None))
    resp.raise_for_status()
    return resp.json()


def _materialise_agent(user_id: str, item: dict) -> bool:
    """Write one agent definition if its folder is not already there."""
    slug = str(item.get("slug") or "").strip()
    if not slug:
        return False
    if layout.user_custom_agent_dir(user_id, slug).exists():
        return False
    try:
        spec = AgentSpec.model_validate(item.get("spec") or {})
    except Exception:
        # A spec chat_db holds but this build cannot parse (an older shape, a
        # model since removed). Skip it rather than failing the whole user —
        # the definition is still safe in Postgres.
        logger.warning(
            "workspace_hydrate_spec_invalid",
            "Stored agent spec did not validate against this build; skipping",
            user_id=user_id,
            agent_slug=slug,
        )
        return False
    files = [
        AgentFile(path=f["path"], content=f["content"], encoding="utf-8")
        for f in item.get("files") or []
        if f.get("path")
    ]
    write_user_agent(user_id, spec, files)
    return True


def _materialise_skill(user_id: str, item: dict, existing: set[str]) -> bool:
    """Add one pool skill if the user's manifest does not already list it."""
    name = str(item.get("name") or "").strip()
    if not name or name in existing:
        return False
    if item.get("type") == "global":
        add_global_to_user(user_id, name)
        return True
    files = [
        SkillFile(path=f["path"], content=f["content"], encoding="utf-8")
        for f in item.get("files") or []
        if f.get("path")
    ]
    if not files:
        # A custom skill whose content was adopted as metadata-only (the pool
        # manifest carries no file bodies). Nothing to write yet; the folder on
        # this volume is still the copy serving runs.
        return False
    add_custom_to_user(
        user_id,
        CustomSkillCreate(
            name=name,
            description=str(item.get("description") or ""),
            category=item.get("category"),
            files=files,
        ),
        created_by_agent=item.get("createdByAgent"),
    )
    return True


async def _hydrate_user(client: httpx.AsyncClient, user_id: str) -> tuple[int, int, int]:
    content = await _get(client, f"/v1/internal/workspace/users/{user_id}")

    agents = sum(
        1 for item in content.get("agents") or [] if _materialise_agent(user_id, item)
    )

    existing = {entry.name for entry in read_user_manifest(user_id).skills}
    skills = sum(
        1 for item in content.get("skills") or [] if _materialise_skill(user_id, item, existing)
    )

    assigned = 0
    for agent_slug, names in (content.get("assignments") or {}).items():
        for name in names:
            try:
                assign_user_skill_to_agent(
                    user_id=user_id, agent_slug=agent_slug, skill_name=name
                )
                assigned += 1
            except Exception:
                # Usually means the skill is not in this volume's pool yet. Not
                # fatal: the assignment row survives in chat_db and the next
                # boot retries once the pool entry exists.
                logger.warning(
                    "workspace_hydrate_assignment_skipped",
                    "Could not assign a skill during hydration; will retry next boot",
                    user_id=user_id,
                    agent_slug=agent_slug,
                    skill_name=name,
                    exc_info=True,
                )
    return agents, skills, assigned


async def hydrate_workspaces(stop_event: asyncio.Event) -> None:
    """Rebuild every user's authored content that is missing from this volume."""
    if not settings.bridge.hydrate_on_startup:
        logger.info("workspace_hydrate_disabled", "Workspace hydration disabled via settings")
        return

    # The bridge may still be starting. Back off and retry a few times rather
    # than racing it — this is a recovery pass, not a request path.
    delay = settings.bridge.hydrate_retry_seconds
    for attempt in range(1, settings.bridge.hydrate_max_attempts + 1):
        if stop_event.is_set():
            return
        try:
            timeout = httpx.Timeout(
                settings.bridge.request_timeout_seconds,
                connect=settings.bridge.connect_timeout_seconds,
            )
            async with httpx.AsyncClient(
                timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
            ) as client:
                user_ids = await _get(client, "/v1/internal/workspace/users")
                totals = [0, 0, 0]
                for user_id in user_ids or []:
                    if stop_event.is_set():
                        return
                    try:
                        a, s, g = await _hydrate_user(client, str(user_id))
                        totals = [totals[0] + a, totals[1] + s, totals[2] + g]
                    except Exception:
                        logger.warning(
                            "workspace_hydrate_user_failed",
                            "Could not hydrate one user's workspace; continuing",
                            user_id=str(user_id),
                            exc_info=True,
                        )
                logger.info(
                    "workspace_hydrate_completed",
                    "Workspace hydration pass completed",
                    user_count=len(user_ids or []),
                    agents_written=totals[0],
                    skills_written=totals[1],
                    assignments_written=totals[2],
                )
                return
        except Exception:
            logger.warning(
                "workspace_hydrate_attempt_failed",
                "Workspace hydration attempt failed; will retry",
                attempt=attempt,
                max_attempts=settings.bridge.hydrate_max_attempts,
            )
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=delay)
                return
            except asyncio.TimeoutError:
                delay = min(delay * 2, 60.0)

    logger.error(
        "workspace_hydrate_gave_up",
        "Workspace hydration did not complete; the volume may be missing authored content",
    )


__all__ = ["hydrate_workspaces"]
