"""Per-(user, agent) tool overrides, owned by ``chat_db``.

An agent declares a baseline tool set and the always-on native builtins sit on
top of it. The user keeps two override sets per agent, and the effective set the
agent builds with is::

    effective = (declared ∪ user_enabled) − user_disabled

These used to live only in ``<agent_root>/tool_prefs.json`` on the
agents-service volume, which has no backup: losing it reverted every user's tool
choices to the declared baseline, silently.

They belong here for the same reason ``use_memory``, ``search_past_convs`` and
``personalization`` already do — they are preferences about how an agent
behaves, the user writes them through the bridge, and they reach the agent by
riding the run config. That is what makes this simpler than custom agents and
skills: **there is no materialised copy on the volume**, so nothing needs
reconciling. The row is the only home.

``tool_key`` is the canonical tool-cache-key (``<server>/<tool>`` for MCP, the
bare name for native tools) and is stored verbatim, because the runtime matches
it against live tools by that exact string.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import UserAgentToolPrefTable
from core.logging import get_logger

logger = get_logger(__name__)

STATE_DISABLED = "disabled"
STATE_ENABLED = "enabled"

# A marker that this pair's legacy ``tool_prefs.json`` has already been read.
#
# Adoption cannot be gated on "the pair has no overrides": that is ambiguous
# between *never adopted* and *adopted, then cleared back to the default*. The
# second is an ordinary thing to do — turning an enabled gateway tool back off
# deletes its row — and re-running adoption there re-applies the stale file,
# silently reverting the user's choice.
#
# The marker is a row like any other, distinguished by its state, so it needs no
# schema of its own. ``read_pair`` matches the two real states explicitly, so it
# never leaks into a tool set, and ``ADOPTION_KEY`` is not a legal tool key so it
# can never collide with one. Both go away with the legacy file:
# ``DELETE FROM user_agent_tool_prefs WHERE state = 'adopted'``.
STATE_ADOPTED = "adopted"
ADOPTION_KEY = "*"


async def read_pair(
    db: AsyncSession, user_id: str, agent_slug: str
) -> Tuple[Set[str], Set[str]]:
    """Return ``(disabled, enabled)`` key sets for this (user, agent).

    Two empty sets is the correct answer for a pair with no overrides — it means
    "the agent's declared baseline", which is exactly what the caller should
    apply. There is no error case worth distinguishing here.
    """
    rows = (
        await db.execute(
            select(UserAgentToolPrefTable).where(
                UserAgentToolPrefTable.user_id == user_id,
                UserAgentToolPrefTable.agent_slug == agent_slug,
            )
        )
    ).scalars().all()

    disabled = {r.tool_key for r in rows if r.state == STATE_DISABLED}
    enabled = {r.tool_key for r in rows if r.state == STATE_ENABLED}
    return disabled, enabled


async def has_adopted(db: AsyncSession, user_id: str, agent_slug: str) -> bool:
    """Whether this pair's legacy file has already been read.

    Deliberately *not* "does the pair have any override": a user who clears their
    last override is indistinguishable from one who was never adopted, and
    re-adopting there resurrects the choice they just undid.
    """
    found = await db.execute(
        select(UserAgentToolPrefTable.id)
        .where(
            UserAgentToolPrefTable.user_id == user_id,
            UserAgentToolPrefTable.agent_slug == agent_slug,
            UserAgentToolPrefTable.state == STATE_ADOPTED,
        )
        .limit(1)
    )
    return found.scalar_one_or_none() is not None


async def set_override(
    db: AsyncSession, user_id: str, agent_slug: str, tool_key: str, state: str
) -> None:
    """Record one override, replacing the opposite state if it is present.

    ``disabled`` and ``enabled`` are mutually exclusive for a key: a tool cannot
    be both turned off and turned on. Storing them in one table with a ``state``
    column is what makes that impossible to express, rather than a rule two
    tables would have to agree to keep.
    """
    if state not in (STATE_DISABLED, STATE_ENABLED, STATE_ADOPTED):
        raise ValueError(f"Unknown tool-pref state {state!r}")

    row = (
        await db.execute(
            select(UserAgentToolPrefTable).where(
                UserAgentToolPrefTable.user_id == user_id,
                UserAgentToolPrefTable.agent_slug == agent_slug,
                UserAgentToolPrefTable.tool_key == tool_key,
            )
        )
    ).scalar_one_or_none()

    if row is None:
        db.add(
            UserAgentToolPrefTable(
                user_id=user_id,
                agent_slug=agent_slug,
                tool_key=tool_key,
                state=state,
            )
        )
    else:
        row.state = state


async def clear_override(
    db: AsyncSession, user_id: str, agent_slug: str, tool_key: str
) -> None:
    """Drop one override — the tool goes back to whatever the baseline says.

    A real delete, not a tombstone: there is no second copy to disambiguate
    against, which is the only thing a tombstone would buy.
    """
    await db.execute(
        delete(UserAgentToolPrefTable).where(
            UserAgentToolPrefTable.user_id == user_id,
            UserAgentToolPrefTable.agent_slug == agent_slug,
            UserAgentToolPrefTable.tool_key == tool_key,
        )
    )


async def apply_toggle(
    db: AsyncSession,
    user_id: str,
    agent_slug: str,
    tool_key: str,
    *,
    disabled: bool,
    declared: bool,
) -> None:
    """Translate one UI toggle into the right override — or into none at all.

    The UI sends a single boolean, but what it means depends on the tool's
    default. Turning a *declared* tool off is a `disabled` override; turning it
    back on is the absence of one. For an undeclared gateway tool it is the
    mirror image: on is an `enabled` override, off is the absence of one.

    Writing "back to default" as a deleted row rather than a stored opposite is
    what keeps the table proportional to real choices — otherwise every tool a
    user ever glanced at would accumulate a row saying "normal".
    """
    if declared:
        if disabled:
            await set_override(db, user_id, agent_slug, tool_key, STATE_DISABLED)
        else:
            await clear_override(db, user_id, agent_slug, tool_key)
        return

    # Undeclared: the tool is off unless the user turned it on.
    if disabled:
        await clear_override(db, user_id, agent_slug, tool_key)
    else:
        await set_override(db, user_id, agent_slug, tool_key, STATE_ENABLED)


async def adopt_pair(
    db: AsyncSession,
    user_id: str,
    agent_slug: str,
    *,
    disabled: Iterable[str],
    enabled: Iterable[str],
) -> int:
    """Take a pair's overrides from the volume copy. Returns how many landed.

    Lazy migration for the ``tool_prefs.json`` files that pre-date this table.
    It rides the tool-list call the Agents tab already makes, so it costs no
    extra round trip, and it is skipped entirely once the pair has any row.

    The marker is written **even when the file is empty**, so a pair is read at
    most once. Without it an empty file would be re-read forever, and — worse —
    a pair that was adopted and then cleared back to default would be adopted
    again, undoing the user's change.
    """
    count = 0
    for key in disabled:
        if key:
            await set_override(db, user_id, agent_slug, str(key), STATE_DISABLED)
            count += 1
    for key in enabled:
        if key:
            await set_override(db, user_id, agent_slug, str(key), STATE_ENABLED)
            count += 1

    await set_override(db, user_id, agent_slug, ADOPTION_KEY, STATE_ADOPTED)

    if count:
        logger.info(
            "agent_tool_prefs_adopted",
            "Adopted volume-only tool overrides into chat_db",
            user_id=user_id,
            agent_slug=agent_slug,
            count=count,
        )
    return count


def apply_to_rows(
    rows: List[Dict[str, Any]], disabled: Set[str], enabled: Set[str]
) -> List[Dict[str, Any]]:
    """Overlay our stored overrides onto the agents service's tool list.

    The agents service owns the tool *manifest* — which tools exist, whether the
    agent declared them, their descriptions — and still answers that. It no
    longer owns the user's choices, so its ``disabled`` flag is ignored and
    recomputed here from the rows.
    """
    out: List[Dict[str, Any]] = []
    for row in rows:
        key = str(row.get("key") or "")
        is_declared = bool(row.get("declared", True))
        if is_declared:
            row_disabled = key in disabled
        else:
            # An undeclared gateway tool is off unless the user enabled it.
            row_disabled = key not in enabled
        out.append({**row, "disabled": row_disabled})
    return out


__all__ = [
    "ADOPTION_KEY",
    "STATE_ADOPTED",
    "STATE_DISABLED",
    "STATE_ENABLED",
    "adopt_pair",
    "apply_to_rows",
    "apply_toggle",
    "clear_override",
    "has_adopted",
    "read_pair",
    "set_override",
]
