"""The facts a system prompt is allowed to depend on.

Every platform-owned prompt section is a pure function of this object. That is
the whole point: a section can only describe a mount or a tool that the run
actually has, because the same flags that build the mounts fill this in.

Advertising a capability that is not there is worse than saying nothing — the
agent tries it, gets an error, and then distrusts the rest of its prompt. The
filesystem permission ladder already works this way
(``workspace_write_deny(include_reference=...)`` derives from the same flag as
the mount); this mirrors it for the prompt.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class PromptContext:
    """What this run actually has. Defaults are the empty run: nothing mounted."""

    #: ``/memories/`` is mounted and ``remember`` / ``forget`` are attached.
    use_memory: bool = False
    #: There is a conversation, so the ``/conversation/`` mounts exist along
    #: with the tools that point into them.
    has_conversation: bool = False
    #: ``/reference/`` is mounted — the agent's own definition folder. Only
    #: declarative agents have one; a code-defined agent's package is source.
    has_reference: bool = False
    #: ``/default_skills/`` is mounted (skills the agent ships with).
    has_default_skills: bool = False
    #: Cross-conversation recall is opted in.
    search_past_convs: bool = False
    #: The sandbox is enabled, so ``execute`` exists.
    sandbox_enabled: bool = False
    #: This agent has sub-agents, so the "only the orchestrator presents"
    #: rule is worth stating. The rule is platform-wide — the normalizer drops
    #: a sub-agent's ``present_artifact`` for every deep agent — but it only
    #: *applies* to an agent that can delegate, and is noise to one that cannot.
    has_subagents: bool = False
    #: Wall-clock for the run, injected rather than read inside a prompt so the
    #: composed text is deterministic under test.
    now: Optional[datetime] = None
    #: The already-composed personalization block, or "" when inactive. Passed
    #: through rather than rebuilt here — ``harness.personalization`` owns its
    #: wording and hardening.
    personalization: str = ""


__all__ = ["PromptContext"]
