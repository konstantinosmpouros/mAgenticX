"""Keep the daily usage rollups (plan 33): add one finished answer to its day.

``usage_daily`` and ``usage_daily_groups`` hold, per user, UTC day and agent,
what ``messages`` and ``message_usage`` would sum to (and ``tool_usage_daily``,
plan 41, what ``tool_usage`` would) — so the Usage tab's
Overview and Agents pages read a few hundred rows instead of every answer the
user ever got (see migration 0034 for why that matters).

Called from ``_finish_run`` inside the transaction that finalises the answer,
so the answer and its rollups land together or not at all. Each write is an
upsert that ADDS to the day's row (``col = col + new``): concurrent answers on
the same day can never lose each other's update, and nothing is ever read
back first.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ToolUsageDailyTable, UsageDailyGroupTable, UsageDailyTable

UNKNOWN_AGENT = "Unknown agent"


def agent_key_for(agent_id: Optional[str], agent_name: Optional[str]) -> str:
    """An answer's agent identity in the rollups: its id, or its name if it has none."""
    return agent_id or f"name:{agent_name or UNKNOWN_AGENT}"


async def _add(db: AsyncSession, table: Any, keys: tuple[str, ...], row: dict[str, Any], counters: tuple[str, ...]) -> None:
    """Insert ``row``, or add its counters to the existing row with the same key.

    The dialect's own ``ON CONFLICT … DO UPDATE``: Postgres in production,
    SQLite under the test suite. The agent's label follows the latest answer,
    so a rename shows up; its id is never rewritten, so a deletion (id NULL by
    the foreign key) is never undone.
    """
    insert = postgres_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    statement = insert(table).values(**row)
    updates: dict[str, Any] = {name: table.__table__.c[name] + statement.excluded[name] for name in counters}
    updates["agent_name"] = statement.excluded.agent_name
    await db.execute(statement.on_conflict_do_update(index_elements=list(keys), set_=updates))


async def add_answer_to_rollups(
    db: AsyncSession,
    *,
    user_id: str,
    day: date,
    agent_id: Optional[str],
    agent_name: Optional[str],
    answer: dict[str, int],
    groups: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
) -> None:
    """Add one answer's totals to its day, and each of its usage groups to theirs.

    ``answer`` carries the ``usage_daily`` counters (answers, tokens, model
    time, calls, the ``detailed_*`` pair, plan 41's cost / truncation / first
    token); ``groups`` one dict per (scope, group_name, model_name) with the
    ``usage_daily_groups`` counters; ``tools`` one dict per ``tool_name`` with
    the ``tool_usage_daily`` counters (plan 41). Only the counters a caller
    passes are added, so each caller books exactly what it measured.
    """
    identity = {
        "user_id": user_id,
        "day": day,
        "agent_key": agent_key_for(agent_id, agent_name),
        "agent_id": agent_id,
        "agent_name": agent_name,
    }
    await _add(
        db,
        UsageDailyTable,
        ("user_id", "day", "agent_key"),
        {**identity, **answer},
        tuple(answer),
    )
    for group in groups:
        counters = tuple(name for name in group if name not in ("scope", "group_name", "model_name"))
        await _add(
            db,
            UsageDailyGroupTable,
            ("user_id", "day", "agent_key", "scope", "group_name", "model_name"),
            {**identity, **group},
            counters,
        )
    for tool in tools or ():
        await _add(
            db,
            ToolUsageDailyTable,
            ("user_id", "day", "agent_key", "tool_name"),
            {**identity, **tool},
            tuple(name for name in tool if name != "tool_name"),
        )
