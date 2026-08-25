"""Workspace-wide token/run usage aggregates for the Settings → Usage tab.

Read-only rollups over the ``messages`` table (AI messages carry
``input_tokens``/``output_tokens``; ``agent_name`` is denormalized so a
breakdown survives agent deletion). Everything is computed in three aggregate
queries scoped to the requesting user via the ``conversations`` join — no new
columns, no schema change, and the result is bounded (fixed windows, capped
agent list), so no pagination is needed.

Timestamps are stored naive-UTC, so window cutoffs and daily buckets are
computed in UTC as well; the client labels days locally but buckets stay UTC.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ConversationTable, MessageTable
from schema import UsageAgentBreakdown, UsageDailyPoint, UsageSummary, UsageWindow

# Cap the per-agent breakdown so the payload stays bounded no matter how many
# agents a user has talked to; the UI shows a ranked list, not a full export.
MAX_AGENT_ROWS = 12

# The daily series and the "recent" windows share the same horizon.
DAILY_WINDOW_DAYS = 30

# Reusable NULL-safe token columns: token counts are nullable on rows written
# before usage tracking existed, and SUM over an empty set is NULL.
_IN = func.coalesce(MessageTable.input_tokens, 0)
_OUT = func.coalesce(MessageTable.output_tokens, 0)


def _window(values: tuple[int, int, int]) -> UsageWindow:
    """Build a UsageWindow from an (input, output, messages) aggregate tuple."""
    input_tokens, output_tokens, ai_messages = (int(v or 0) for v in values)
    return UsageWindow(
        inputTokens=input_tokens,
        outputTokens=output_tokens,
        totalTokens=input_tokens + output_tokens,
        aiMessages=ai_messages,
    )


async def compute_usage_summary(db: AsyncSession, user_id: str) -> UsageSummary:
    """Aggregate the user's usage into the UsageSummary payload.

    One query computes the all-time totals plus the three recency windows in a
    single pass (FILTER clauses), one groups by agent, one groups by day —
    three round trips total, all driven through the existing
    ``conversations.user_id`` / ``messages.conversation_id`` indexes.
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff_7d = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=DAILY_WINDOW_DAYS)

    def windowed(cutoff: datetime) -> list:
        cond = MessageTable.created_at >= cutoff
        return [
            func.coalesce(func.sum(_IN).filter(cond), 0),
            func.coalesce(func.sum(_OUT).filter(cond), 0),
            func.count().filter(cond),
        ]

    scoped_where = (ConversationTable.user_id == user_id, MessageTable.sender == "ai")

    totals_stmt = (
        select(
            func.coalesce(func.sum(_IN), 0),
            func.coalesce(func.sum(_OUT), 0),
            func.count(),
            func.count(func.distinct(MessageTable.conversation_id)),
            *windowed(today_start),
            *windowed(cutoff_7d),
            *windowed(cutoff_30d),
        )
        .select_from(MessageTable)
        .join(ConversationTable, MessageTable.conversation_id == ConversationTable.id)
        .where(*scoped_where)
    )
    row = (await db.execute(totals_stmt)).one()

    agent_label = func.coalesce(MessageTable.agent_name, "Unknown agent").label("agent_name")
    total_tokens = (func.coalesce(func.sum(_IN), 0) + func.coalesce(func.sum(_OUT), 0)).label("total_tokens")
    per_agent_stmt = (
        select(
            agent_label,
            func.coalesce(func.sum(_IN), 0),
            func.coalesce(func.sum(_OUT), 0),
            func.count(),
            total_tokens,
        )
        .select_from(MessageTable)
        .join(ConversationTable, MessageTable.conversation_id == ConversationTable.id)
        .where(*scoped_where)
        .group_by(agent_label)
        .order_by(desc("total_tokens"))
        .limit(MAX_AGENT_ROWS)
    )
    agent_rows = (await db.execute(per_agent_stmt)).all()

    day_bucket = func.date_trunc("day", MessageTable.created_at).label("day")
    daily_stmt = (
        select(
            day_bucket,
            func.coalesce(func.sum(_IN), 0),
            func.coalesce(func.sum(_OUT), 0),
            func.count(),
        )
        .select_from(MessageTable)
        .join(ConversationTable, MessageTable.conversation_id == ConversationTable.id)
        .where(*scoped_where, MessageTable.created_at >= cutoff_30d)
        .group_by(day_bucket)
        .order_by(day_bucket)
    )
    daily_rows = (await db.execute(daily_stmt)).all()

    return UsageSummary(
        totals=_window((row[0], row[1], row[2])),
        conversations=int(row[3] or 0),
        today=_window((row[4], row[5], row[6])),
        last7Days=_window((row[7], row[8], row[9])),
        last30Days=_window((row[10], row[11], row[12])),
        perAgent=[
            UsageAgentBreakdown(
                agentName=str(agent_name),
                inputTokens=int(input_tokens or 0),
                outputTokens=int(output_tokens or 0),
                totalTokens=int(input_tokens or 0) + int(output_tokens or 0),
                aiMessages=int(ai_messages or 0),
            )
            for agent_name, input_tokens, output_tokens, ai_messages, _total in agent_rows
        ],
        daily=[
            UsageDailyPoint(
                date=day.date().isoformat(),
                inputTokens=int(input_tokens or 0),
                outputTokens=int(output_tokens or 0),
                totalTokens=int(input_tokens or 0) + int(output_tokens or 0),
                aiMessages=int(ai_messages or 0),
            )
            for day, input_tokens, output_tokens, ai_messages in daily_rows
        ],
    )
