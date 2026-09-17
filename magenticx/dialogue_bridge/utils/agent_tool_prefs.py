"""Per-(user, agent) tool choices, owned by ``chat_db``.

Two orthogonal axes on one row, because a tool can be switched on *and* gated:

* ``state`` — ``'enabled'`` / ``'disabled'`` / ``NULL``. **MCP tools only**: a
  builtin is constructed by the framework or the native registry and cannot be
  filtered, so the bridge refuses to write this for one.
* ``requires_approval`` — either kind, tri-state: ``NULL`` follows the
  baseline, ``True`` gates, ``False`` clears a gate the baseline sets. A plain
  boolean could not express the last case, and prebuilt tools default to gated.

Both reach the agent on the run config, the way ``use_memory`` and
``personalization`` already do, so there is no copy on the volume to reconcile.

``tool_key`` is stored verbatim — ``<server>/<tool>`` for MCP, the bare name for
a builtin — because the runtime matches it against live tools by that exact
string.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import UserAgentToolPrefTable
from core.logging import get_logger

logger = get_logger(__name__)

STATE_DISABLED = "disabled"
STATE_ENABLED = "enabled"


async def read_prefs(
    db: AsyncSession, user_id: str, agent_slug: str
) -> Tuple[Set[str], Set[str], Dict[str, bool]]:
    """Return ``(disabled, enabled, approvals)`` for this (user, agent).

    ``approvals`` maps a tool key to the user's explicit choice; a key absent
    from it has none and follows the baseline. Empty throughout is the correct
    answer for a pair the user never configured.
    """
    rows = (
        await db.execute(
            select(UserAgentToolPrefTable).where(
                UserAgentToolPrefTable.user_id == user_id,
                UserAgentToolPrefTable.agent_slug == agent_slug,
            )
        )
    ).scalars().all()

    return (
        {r.tool_key for r in rows if r.state == STATE_DISABLED},
        {r.tool_key for r in rows if r.state == STATE_ENABLED},
        {r.tool_key: bool(r.requires_approval) for r in rows if r.requires_approval is not None},
    )


async def read_config(db: AsyncSession, user_id: str, agent_slug: str) -> Dict[str, Any]:
    """The run-config object the agent decodes. Sorted for a stable payload."""
    disabled, enabled, approvals = await read_prefs(db, user_id, agent_slug)
    return {
        "enabled": sorted(enabled),
        "disabled": sorted(disabled),
        "approvals": dict(sorted(approvals.items())),
    }


async def _row_for(
    db: AsyncSession, user_id: str, agent_slug: str, tool_key: str
) -> Optional[UserAgentToolPrefTable]:
    return (
        await db.execute(
            select(UserAgentToolPrefTable).where(
                UserAgentToolPrefTable.user_id == user_id,
                UserAgentToolPrefTable.agent_slug == agent_slug,
                UserAgentToolPrefTable.tool_key == tool_key,
            )
        )
    ).scalar_one_or_none()


async def _drop_if_empty(db: AsyncSession, row: UserAgentToolPrefTable) -> None:
    """Delete a row carrying neither axis, so the table stays proportional to the
    choices a user actually made rather than accumulating rows meaning "normal"."""
    if row.state is None and row.requires_approval is None:
        await db.delete(row)


async def set_enabled(
    db: AsyncSession, user_id: str, agent_slug: str, tool_key: str, *, enabled: bool, declared: bool
) -> None:
    """Record one MCP on/off choice, or clear it when it matches the default.

    What the choice *means* depends on the tool's default: turning a declared
    tool off is a stored override and turning it back on is the absence of one;
    for an undeclared gateway tool it is the mirror image. Writing
    back-to-default as a deleted row is what keeps the table proportional.
    """
    wants_override = (not enabled) if declared else enabled
    if not wants_override:
        row = await _row_for(db, user_id, agent_slug, tool_key)
        if row is None:
            return
        row.state = None
        await _drop_if_empty(db, row)
        return

    state = STATE_DISABLED if declared else STATE_ENABLED
    row = await _row_for(db, user_id, agent_slug, tool_key)
    if row is None:
        db.add(
            UserAgentToolPrefTable(
                user_id=user_id,
                agent_slug=agent_slug,
                tool_key=tool_key,
                state=state,
                requires_approval=None,
            )
        )
        return
    row.state = state


async def set_approval(
    db: AsyncSession, user_id: str, agent_slug: str, tool_key: str, *, required: bool, baseline: bool
) -> None:
    """Record one approval choice, or clear it when it matches the baseline.

    ``baseline`` is what the agent gates before anyone chooses. Matching it
    stores nothing, so the table holds real choices only; differing from it
    stores the explicit value — which is how a prebuilt tool's default gate gets
    turned off at all.

    A locked gate is never reachable here: the caller refuses it, and the runtime
    merges locked gates after every user choice regardless.
    """
    row = await _row_for(db, user_id, agent_slug, tool_key)
    value = None if required == baseline else required

    if row is None:
        if value is None:
            return
        db.add(
            UserAgentToolPrefTable(
                user_id=user_id,
                agent_slug=agent_slug,
                tool_key=tool_key,
                state=None,
                requires_approval=value,
            )
        )
        return

    row.requires_approval = value
    await _drop_if_empty(db, row)


def apply_to_rows(
    rows: List[Dict[str, Any]], disabled: Set[str], enabled: Set[str], approvals: Dict[str, bool]
) -> List[Dict[str, Any]]:
    """Overlay the user's choices onto the agents service's baseline rows.

    That service owns the *manifest* — which tools exist, their kind, what the
    agent declares, what it gates before anyone chooses. It owns none of the
    user's choices, so those are recomputed here.
    """
    out: List[Dict[str, Any]] = []
    for row in rows:
        key = str(row.get("key") or "")
        is_builtin = row.get("kind") == "builtin"
        if is_builtin:
            row_enabled = True
        elif row.get("declared", True):
            row_enabled = key not in disabled
        else:
            row_enabled = key in enabled
        # The user's explicit choice wins over the baseline; a locked gate wins
        # over both, because reporting it off would show a live switch for a
        # control that does nothing.
        approval = approvals.get(key, bool(row.get("approval")))
        out.append(
            {
                **row,
                "enabled": row_enabled,
                "approval": bool(row.get("approvalLocked")) or approval,
            }
        )
    return out


__all__ = [
    "STATE_DISABLED",
    "STATE_ENABLED",
    "apply_to_rows",
    "read_config",
    "read_prefs",
    "set_approval",
    "set_enabled",
]
