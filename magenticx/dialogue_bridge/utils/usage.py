"""Usage analytics for the Settings → Usage tab (plan 33).

Five read-only views, one per page of the tab:

* ``compute_usage_summary`` — the Overview: all-time totals, recency windows
  (and the week before, for "vs last week"), agent and model rankings, a
  30-day daily series and the counts behind the two drill-in cards.
* ``list_usage_conversations`` / ``get_usage_conversation`` — the conversation
  list (a keyset page over the per-conversation running totals) and one
  conversation's analysis.
* ``list_usage_agents`` / ``get_usage_agent`` — every agent as an entity
  (platform, custom, deleted) and one agent's profile.

Every page reads pre-aggregated data, never a sum over the user's answers:
the Overview and Agents pages read the daily rollups (``usage_daily``,
``usage_daily_groups`` — migration 0034 — and ``tool_usage_daily``, plan 41),
the conversation list reads the ``conversations.usage_*`` running totals, and
one conversation reads only its own answers and ``message_usage`` /
``tool_usage`` rows. All of it is kept by ``_finish_run``.
Every query is scoped to the caller and every list is capped, so a response
is bounded however much the user has used the platform.

Only portable SQL (``FILTER``, ``||``, ``ON CONFLICT``), so the SQLite test
suite runs the same queries production runs. Times are naive UTC; "today" and
the day buckets are UTC days.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy import Float, String, and_, cast, desc, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    AgentTable,
    ConversationTable,
    MessageTable,
    MessageUsageTable,
    ToolUsageDailyTable,
    ToolUsageTable,
    UsageDailyGroupTable,
    UsageDailyTable,
)
from schema import (
    UsageAgentBreakdown,
    UsageAgentConversation,
    UsageAgentDetail,
    UsageAgentEntity,
    UsageAgentGroup,
    UsageAgentList,
    UsageAnswerPoint,
    UsageConversationDetail,
    UsageConversationPage,
    UsageConversationRow,
    UsageDailyPoint,
    UsageModelBreakdown,
    UsagePrivateAggregate,
    UsageSummary,
    UsageToolBreakdown,
    UsageWindow,
)
from utils.run_activity import count_run_activity

# Rankings stay short: the Overview shows a top list, not an export.
MAX_AGENT_ROWS = 12
MAX_MODEL_ROWS = 12
MAX_TOOL_ROWS = 12
# One agent's or one conversation's tools: every tool it used, within reason.
MAX_DETAIL_TOOL_ROWS = 50
# The Agents page lists every agent entity a user has worked with — capped.
MAX_AGENT_ENTITIES = 50
# The daily series and the "recent" windows share the same horizon.
DAILY_WINDOW_DAYS = 30
# One agent's trend never reaches further back than this, whatever the range.
MAX_TREND_DAYS = 90
# A conversation's branch chart and answer list: the newest answers only.
MAX_BRANCH_POINTS = 500
# Answers from before plan 33 have no stored call counts; the conversation page
# counts them from their event logs, but never for more than this many.
MAX_LIVE_COUNTED_ANSWERS = 200
TOP_CONVERSATIONS = 10
# "Near compaction": the last answer filled at least this much of the window.
NEAR_COMPACTION_FRACTION = 0.7

RANGE_DAYS: dict[str, Optional[int]] = {"7d": 7, "30d": 30, "90d": 90, "all": None}

# Conversation ids are UUIDs; agent ids are UUIDs for custom agents but the
# manifest's own ids for platform ones ("Omni-Agent v1"). Both only ever
# reach SQL as bound parameters — these checks keep junk out, not injection.
_ROW_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_AGENT_ID = re.compile(r"^[^\x00-\x1f/\\]{1,128}$")
_MAX_CURSOR_LENGTH = 512
_NAME_KEY_PREFIX = "name:"
_UNKNOWN_AGENT = "Unknown agent"

# The daily rollups (migration 0034): every Overview and Agents figure is a sum
# over these, a few hundred rows per user instead of every answer.
_DAY = UsageDailyTable
_GROUP = UsageDailyGroupTable
# Column order matches UsageWindow: the same builder reads both.
_WINDOW_SOURCES = (
    _DAY.input_tokens, _DAY.output_tokens, _DAY.answers, _DAY.cached_input_tokens, _DAY.reasoning_tokens,
    _DAY.model_ms, _DAY.model_calls, _DAY.tool_calls, _DAY.detailed_answers, _DAY.detailed_input_tokens,
    # Plan 41.
    _DAY.cost_micros, _DAY.unpriced_calls, _DAY.truncated_calls, _DAY.first_token_ms, _DAY.first_token_answers,
)
_WINDOW_WIDTH = len(_WINDOW_SOURCES)
# The tool rollup (plan 41): which tools ran, per user, day and main agent.
_TOOL_DAY = ToolUsageDailyTable
# Plan 41's per-call metrics, in CallMetrics order, on message_usage and on
# usage_daily_groups (the same column names on both).
_CALL_METRICS = ("cost_micros", "unpriced_calls", "truncated_calls", "ttft_ms", "ttft_calls", "gen_ms", "gen_output_tokens")
_CALL_METRIC_FIELDS = ("costMicros", "unpricedCalls", "truncatedCalls", "ttftMs", "ttftCalls", "genMs", "genOutputTokens")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _today() -> date:
    return _utcnow().date()


def _range_cutoff(range_key: str) -> Optional[datetime]:
    days = RANGE_DAYS[range_key]
    return None if days is None else _utcnow() - timedelta(days=days)


def _range_first_day(range_key: str) -> Optional[date]:
    """The first UTC day a range covers, today included ("7d" = today and 6 before)."""
    days = RANGE_DAYS[range_key]
    return None if days is None else _today() - timedelta(days=days - 1)


def _int(value: Any) -> int:
    return int(value or 0)


def _window_columns(cond=None) -> list:
    """The ten aggregates of a ``UsageWindow`` over ``usage_daily``, optionally
    restricted by ``cond`` with ``FILTER`` — so several windows share one scan."""
    columns = []
    for source in _WINDOW_SOURCES:
        summed = func.sum(source)
        columns.append(func.coalesce(summed.filter(cond) if cond is not None else summed, 0))
    return columns


def _window(values) -> UsageWindow:
    v = [_int(x) for x in values]
    return UsageWindow(
        inputTokens=v[0], outputTokens=v[1], totalTokens=v[0] + v[1], aiMessages=v[2],
        cachedInputTokens=v[3], reasoningTokens=v[4], modelMs=v[5], modelCalls=v[6],
        toolCalls=v[7], detailedAnswers=v[8], detailedInputTokens=v[9],
        costMicros=v[10], unpricedCalls=v[11], truncatedCalls=v[12], firstTokenMs=v[13],
        firstTokenAnswers=v[14],
    )


def _call_metric_sums(table: Any) -> list:
    """Sums of plan 41's per-call metrics over ``table``, in CallMetrics order."""
    return [func.coalesce(func.sum(table.__table__.c[name]), 0) for name in _CALL_METRICS]


def _call_metrics(values) -> dict[str, int]:
    """CallMetrics keyword arguments from the sums of ``_call_metric_sums``."""
    return {field: _int(value) for field, value in zip(_CALL_METRIC_FIELDS, values)}


def _tool_columns(table: Any) -> list:
    """Per-tool sums, labelled for ``_tool``, over ``tool_usage`` or its rollup."""
    return [
        table.tool_name.label("tool_name"),
        func.sum(table.calls).label("calls"),
        func.sum(table.errors).label("errors"),
        func.sum(table.duration_ms).label("duration_ms"),
        func.sum(table.output_chars).label("output_chars"),
    ]


def _tool(row: Any) -> UsageToolBreakdown:
    return UsageToolBreakdown(
        toolName=str(row.tool_name), calls=_int(row.calls), errors=_int(row.errors),
        durationMs=_int(row.duration_ms), outputChars=_int(row.output_chars),
    )


async def _tools(db: AsyncSession, table: Any, *where, limit: int) -> list[UsageToolBreakdown]:
    """The most-called tools among ``table``'s rows matching ``where``."""
    rows = (await db.execute(
        select(*_tool_columns(table))
        .where(*where)
        .group_by(table.tool_name)
        .order_by(desc(func.sum(table.calls)), table.tool_name)
        .limit(limit)
    )).all()
    return [_tool(r) for r in rows]


def _day(value: Any) -> str:
    """A ``Date`` column comes back as a date on Postgres and a string on SQLite."""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)[:10]


def _identity(table: Any):
    """An agent's identity in a rollup: its id, or ``name:<label>`` once deleted.

    Not the stored ``agent_key``: when an agent is deleted its rows keep the old
    id as key but ``agent_id`` goes NULL, and only its name still identifies it.
    """
    name = func.coalesce(table.agent_name, _UNKNOWN_AGENT)
    return func.coalesce(table.agent_id, literal(_NAME_KEY_PREFIX, String) + name)


# ---------------------------------------------------------------------------
# Overview
# ---------------------------------------------------------------------------
async def compute_usage_summary(db: AsyncSession, user_id: str) -> UsageSummary:
    """Aggregate the user's usage into the Overview payload.

    One pass over the user's ``usage_daily`` rows computes all-time totals and
    four windows (FILTER clauses); one groups by agent, one by model
    (``usage_daily_groups``), one by tool (``tool_usage_daily``), one by day;
    two small counts over the user's conversations feed the drill-in cards.
    """
    today = _today()
    last_7 = today - timedelta(days=6)
    previous_7 = (today - timedelta(days=13), today - timedelta(days=7))
    last_30 = today - timedelta(days=DAILY_WINDOW_DAYS - 1)
    mine = _DAY.user_id == user_id

    row = list((await db.execute(
        select(
            *_window_columns(),
            *_window_columns(_DAY.day == today),
            *_window_columns(_DAY.day >= last_7),
            *_window_columns(and_(_DAY.day >= previous_7[0], _DAY.day <= previous_7[1])),
            *_window_columns(_DAY.day >= last_30),
            func.count(func.distinct(_identity(_DAY))),
        ).where(mine)
    )).one())
    w = _WINDOW_WIDTH
    windows = [row[i * w:(i + 1) * w] for i in range(5)]

    identity = _identity(_DAY).label("agent")
    agent_rows = (await db.execute(
        select(identity, func.max(_DAY.agent_name), *_window_columns())
        .where(mine)
        .group_by(identity)
        .order_by(desc(func.sum(_DAY.input_tokens) + func.sum(_DAY.output_tokens)))
        .limit(MAX_AGENT_ROWS)
    )).all()

    model_rows = (await db.execute(
        select(
            _GROUP.model_name,
            func.sum(_GROUP.calls), func.sum(_GROUP.input_tokens), func.sum(_GROUP.cached_input_tokens),
            func.sum(_GROUP.output_tokens), func.sum(_GROUP.model_ms), *_call_metric_sums(_GROUP),
        )
        .where(_GROUP.user_id == user_id)
        .group_by(_GROUP.model_name)
        .order_by(desc(func.sum(_GROUP.input_tokens) + func.sum(_GROUP.output_tokens)))
        .limit(MAX_MODEL_ROWS)
    )).all()

    per_tool = await _tools(db, _TOOL_DAY, _TOOL_DAY.user_id == user_id, limit=MAX_TOOL_ROWS)

    daily_rows = (await db.execute(
        select(_DAY.day, *_window_columns()).where(mine, _DAY.day >= last_30).group_by(_DAY.day).order_by(_DAY.day)
    )).all()

    conv = ConversationTable
    conversations, near = (await db.execute(
        select(
            func.count(),
            func.count().filter(
                conv.is_private.is_(False),
                conv.last_context_window > 0,
                conv.last_context_tokens >= conv.last_context_window * NEAR_COMPACTION_FRACTION,
            ),
        ).where(conv.user_id == user_id, conv.usage_answers > 0)
    )).one()

    return UsageSummary(
        totals=_window(windows[0]),
        conversations=_int(conversations),
        today=_window(windows[1]),
        last7Days=_window(windows[2]),
        previous7Days=_window(windows[3]),
        last30Days=_window(windows[4]),
        perAgent=[
            UsageAgentBreakdown(agentName=str(r[1] or _UNKNOWN_AGENT), **_window(r[2:]).model_dump())
            for r in agent_rows
        ],
        perModel=[
            UsageModelBreakdown(
                model=str(r[0] or "Unknown model"), calls=_int(r[1]), inputTokens=_int(r[2]),
                cachedInputTokens=_int(r[3]), outputTokens=_int(r[4]), modelMs=_int(r[5]),
                **_call_metrics(r[6:]),
            )
            for r in model_rows
        ],
        perTool=per_tool,
        daily=[UsageDailyPoint(date=_day(r[0]), **_window(r[1:]).model_dump()) for r in daily_rows],
        agentCount=_int(row[5 * w]),
        nearCompactionCount=_int(near),
    )


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------
def _encode_cursor(sort: str, value: Any, row_id: str) -> str:
    raw = json.dumps({"s": sort, "v": value, "i": row_id}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _invalid_cursor() -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor.")


def _decode_cursor(cursor: str, sort: str) -> tuple[Any, str]:
    """An opaque keyset cursor back into (sort value, id) — strictly typed.

    Not signed: it only narrows the caller's own, already-scoped rows, so a
    forged one can do no more than page their own list oddly. Every field is
    still validated so a malformed one is a 400, never a query error.
    """
    if len(cursor) > _MAX_CURSOR_LENGTH:
        raise _invalid_cursor()
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except (binascii.Error, ValueError) as exc:
        raise _invalid_cursor() from exc
    if not isinstance(data, dict) or data.get("s") != sort:
        raise _invalid_cursor()
    value, row_id = data.get("v"), data.get("i")
    if not isinstance(row_id, str) or not _ROW_ID.match(row_id):
        raise _invalid_cursor()
    if sort == "tokens" and isinstance(value, int) and not isinstance(value, bool):
        return value, row_id
    if sort == "context" and isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value), row_id
    if sort == "recent" and isinstance(value, str):
        try:
            return datetime.fromisoformat(value), row_id
        except ValueError as exc:
            raise _invalid_cursor() from exc
    raise _invalid_cursor()


def _like_pattern(query: str) -> str:
    escaped = query.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def list_usage_conversations(
    db: AsyncSession,
    user_id: str,
    *,
    sort: str,
    range_key: str,
    agent_id: Optional[str],
    query: Optional[str],
    cursor: Optional[str],
    limit: int,
) -> UsageConversationPage:
    """One keyset page of the caller's conversations, ranked by their running
    totals. Private chats are never listed; on the first page they come back
    as one aggregate (when no search or agent filter would make it misleading).
    """
    if agent_id is not None and not _AGENT_ID.match(agent_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid agent id.")
    conv = ConversationTable
    fill_ratio = cast(conv.last_context_tokens, Float) / conv.last_context_window
    cutoff = _range_cutoff(range_key)

    stmt = (
        select(
            conv.id, conv.title, conv.agent_id, conv.agent_name, AgentTable.icon, conv.is_archived,
            conv.usage_answers, conv.usage_input_tokens, conv.usage_cached_tokens, conv.usage_output_tokens,
            conv.usage_total_tokens, conv.usage_model_calls, conv.usage_tool_calls, conv.usage_model_ms,
            conv.usage_cost_micros, conv.usage_truncated_calls,
            conv.last_context_tokens, conv.last_context_window, conv.usage_updated_at, fill_ratio.label("fill"),
        )
        .outerjoin(AgentTable, AgentTable.id == conv.agent_id)
        .where(conv.user_id == user_id, conv.is_private.is_(False), conv.usage_answers > 0)
    )
    if cutoff is not None:
        stmt = stmt.where(conv.usage_updated_at >= cutoff)
    if agent_id:
        stmt = stmt.where(conv.agent_id == agent_id)
    if query:
        stmt = stmt.where(func.lower(conv.title).like(_like_pattern(query), escape="\\"))

    if sort == "tokens":
        key_column = conv.usage_total_tokens
    elif sort == "recent":
        key_column = conv.usage_updated_at
        stmt = stmt.where(conv.usage_updated_at.is_not(None))
    else:
        key_column = fill_ratio
        stmt = stmt.where(conv.last_context_window > 0, conv.last_context_tokens.is_not(None))
    if cursor:
        value, after_id = _decode_cursor(cursor, sort)
        stmt = stmt.where(or_(key_column < value, and_(key_column == value, conv.id < after_id)))
    stmt = stmt.order_by(key_column.desc(), conv.id.desc()).limit(limit + 1)

    rows = (await db.execute(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [
        UsageConversationRow(
            id=r.id, title=r.title, agentId=r.agent_id, agentName=r.agent_name, agentIcon=r.icon,
            isArchived=bool(r.is_archived), answers=_int(r.usage_answers), inputTokens=_int(r.usage_input_tokens),
            cachedInputTokens=_int(r.usage_cached_tokens), outputTokens=_int(r.usage_output_tokens),
            totalTokens=_int(r.usage_total_tokens), modelCalls=_int(r.usage_model_calls),
            toolCalls=_int(r.usage_tool_calls), modelMs=_int(r.usage_model_ms),
            costMicros=_int(r.usage_cost_micros), truncatedCalls=_int(r.usage_truncated_calls),
            contextTokens=r.last_context_tokens, contextWindow=r.last_context_window,
            updatedAt=r.usage_updated_at,
        )
        for r in rows
    ]
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        value = {
            "tokens": _int(last.usage_total_tokens),
            "recent": last.usage_updated_at.isoformat() if last.usage_updated_at else None,
            "context": float(last.fill) if last.fill is not None else None,
        }[sort]
        next_cursor = _encode_cursor(sort, value, last.id)

    private = None
    if cursor is None and not agent_id and not query:
        private_stmt = select(
            func.count(), func.sum(conv.usage_answers), func.sum(conv.usage_total_tokens)
        ).where(conv.user_id == user_id, conv.is_private.is_(True), conv.usage_answers > 0)
        if cutoff is not None:
            private_stmt = private_stmt.where(conv.usage_updated_at >= cutoff)
        count, answers, total = (await db.execute(private_stmt)).one()
        if _int(count):
            private = UsagePrivateAggregate(conversations=_int(count), answers=_int(answers), totalTokens=_int(total))

    return UsageConversationPage(items=items, nextCursor=next_cursor, private=private)


def _latest_branch(rows: list[Any]) -> set[str]:
    """Ids on the path from the conversation's newest message back to its root
    — the branch the chat opens on. Ties break as the chat orders messages."""
    if not rows:
        return set()
    newest = max(rows, key=lambda r: (r.created_at, r.sender == "ai", r.id))
    parents = {r.id: r.parent_message_id for r in rows}
    branch: set[str] = set()
    current: Optional[str] = newest.id
    while current and current not in branch:
        branch.add(current)
        current = parents.get(current)
    return branch


def _scope(value: Any) -> str:
    """A stored usage scope as the API names it; anything unknown is the main agent's."""
    return value if value in ("subagent", "compaction") else "main"


def _group(row: Any) -> UsageAgentGroup:
    return UsageAgentGroup(
        scope=_scope(row.scope), agentId=row.agent_id,
        agentName=row.agent_name, model=row.model_name, calls=_int(row.calls),
        inputTokens=_int(row.input_tokens), cachedInputTokens=_int(row.cached_input_tokens),
        outputTokens=_int(row.output_tokens), reasoningTokens=_int(row.reasoning_tokens),
        modelMs=_int(row.model_latency_ms),
        **_call_metrics(getattr(row, name) for name in _CALL_METRICS),
    )


def _group_columns() -> list:
    usage = MessageUsageTable
    return [
        usage.scope, usage.agent_id, usage.agent_name, usage.model_name,
        func.sum(usage.calls).label("calls"),
        func.sum(usage.input_tokens).label("input_tokens"),
        func.sum(usage.cached_input_tokens).label("cached_input_tokens"),
        func.sum(usage.output_tokens).label("output_tokens"),
        func.sum(usage.reasoning_tokens).label("reasoning_tokens"),
        func.sum(usage.model_latency_ms).label("model_latency_ms"),
        *(column.label(name) for column, name in zip(_call_metric_sums(usage), _CALL_METRICS)),
    ]


async def get_usage_conversation(db: AsyncSession, user_id: str, conversation_id: str) -> UsageConversationDetail:
    """One conversation's analysis. 404 unless it is the caller's and not private.

    Totals cover every answer, replaced ones included; "replaced" means off the
    latest branch. Answers from before plan 33 have no stored call counts, so up
    to ``MAX_LIVE_COUNTED_ANSWERS`` of them are counted from their event logs —
    exactly as the composer card counts them — and ``callsComplete`` says if
    any were left out.
    """
    conversation = await db.get(ConversationTable, conversation_id)
    if conversation is None or conversation.user_id != user_id or conversation.is_private:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")

    m = MessageTable
    rows = (await db.execute(
        select(
            m.id, m.parent_message_id, m.sender, m.created_at, m.agent_name, m.model_name,
            m.input_tokens, m.output_tokens, m.cached_input_tokens, m.model_calls, m.tool_calls,
            m.model_latency_ms, m.context_tokens, m.context_window, m.compaction_percent,
            m.cost_micros, m.unpriced_calls, m.truncated_calls, m.first_token_ms,
        ).where(m.conversation_id == conversation_id)
    )).all()
    branch_ids = _latest_branch(rows)
    answers = sorted(
        (r for r in rows if r.sender == "ai" and (r.input_tokens is not None or r.output_tokens is not None)),
        key=lambda r: (r.created_at, r.id),
    )

    uncounted = [r.id for r in answers if r.model_calls is None]
    live: dict[str, Any] = {}
    if uncounted:
        logs = (await db.execute(
            select(m.id, m.raw_events).where(m.id.in_(uncounted[-MAX_LIVE_COUNTED_ANSWERS:]))
        )).all()
        live = {row.id: count_run_activity(row.raw_events) for row in logs}

    def calls_of(answer) -> tuple[Optional[int], Optional[int]]:
        if answer.model_calls is not None:
            return answer.model_calls, answer.tool_calls
        activity = live.get(answer.id)
        return (activity.model_calls, activity.tool_calls) if activity else (None, None)

    detail = UsageConversationDetail(
        id=conversation.id, title=conversation.title, isArchived=bool(conversation.is_archived),
        answers=len(answers), replaced=sum(1 for r in answers if r.id not in branch_ids),
        callsComplete=len(uncounted) <= MAX_LIVE_COUNTED_ANSWERS,
    )
    for answer in answers:
        model_calls, tool_calls = calls_of(answer)
        detail.inputTokens += _int(answer.input_tokens)
        detail.outputTokens += _int(answer.output_tokens)
        detail.cachedInputTokens += _int(answer.cached_input_tokens)
        detail.modelMs += _int(answer.model_latency_ms)
        detail.modelCalls += _int(model_calls)
        detail.toolCalls += _int(tool_calls)
        detail.costMicros += _int(answer.cost_micros)
        detail.unpricedCalls += _int(answer.unpriced_calls)
        detail.truncatedCalls += _int(answer.truncated_calls)
        if answer.model_calls is not None:
            detail.detailedAnswers += 1
            detail.detailedInputTokens += _int(answer.input_tokens)
    detail.totalTokens = detail.inputTokens + detail.outputTokens

    group_rows = (await db.execute(
        select(*_group_columns())
        .where(MessageUsageTable.conversation_id == conversation_id)
        .group_by(MessageUsageTable.scope, MessageUsageTable.agent_id, MessageUsageTable.agent_name,
                  MessageUsageTable.model_name)
        .order_by(desc(func.sum(MessageUsageTable.input_tokens) + func.sum(MessageUsageTable.output_tokens)))
    )).all()
    detail.groups = [_group(r) for r in group_rows]
    detail.tools = await _tools(
        db, ToolUsageTable, ToolUsageTable.conversation_id == conversation_id, limit=MAX_DETAIL_TOOL_ROWS
    )

    on_branch = [r for r in answers if r.id in branch_ids]
    detail.branchTruncated = len(on_branch) > MAX_BRANCH_POINTS
    for answer in on_branch[-MAX_BRANCH_POINTS:]:
        model_calls, tool_calls = calls_of(answer)
        detail.branch.append(UsageAnswerPoint(
            id=answer.id, createdAt=answer.created_at, agentName=answer.agent_name, model=answer.model_name,
            inputTokens=_int(answer.input_tokens), outputTokens=_int(answer.output_tokens),
            cachedInputTokens=_int(answer.cached_input_tokens), modelCalls=model_calls, toolCalls=tool_calls,
            modelMs=answer.model_latency_ms, contextTokens=answer.context_tokens,
            contextWindow=answer.context_window, compactionPercent=answer.compaction_percent,
            costMicros=answer.cost_micros, unpricedCalls=answer.unpriced_calls,
            truncatedCalls=answer.truncated_calls, firstTokenMs=answer.first_token_ms,
        ))
    return detail


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------
def _entity_columns() -> list:
    """Per-agent sums over ``usage_daily`` (labelled for ``_entity``)."""
    return [
        func.max(_DAY.agent_id).label("agent_id"),
        func.max(_DAY.agent_name).label("label"),
        func.coalesce(func.sum(_DAY.answers), 0).label("answers"),
        func.coalesce(func.sum(_DAY.input_tokens), 0).label("input_tokens"),
        func.coalesce(func.sum(_DAY.cached_input_tokens), 0).label("cached_tokens"),
        func.coalesce(func.sum(_DAY.output_tokens), 0).label("output_tokens"),
        func.coalesce(func.sum(_DAY.model_ms), 0).label("model_ms"),
        func.coalesce(func.sum(_DAY.model_calls), 0).label("model_calls"),
        func.coalesce(func.sum(_DAY.tool_calls), 0).label("tool_calls"),
        func.coalesce(func.sum(_DAY.detailed_answers), 0).label("detailed"),
        func.coalesce(func.sum(_DAY.detailed_input_tokens), 0).label("detailed_input"),
        func.coalesce(func.sum(_DAY.cost_micros), 0).label("cost_micros"),
        func.coalesce(func.sum(_DAY.truncated_calls), 0).label("truncated_calls"),
        func.max(_DAY.day).label("last_day"),
    ]


def _kind(agent: Optional[AgentTable]) -> str:
    if agent is None:
        return "deleted"
    return "platform" if agent.owner_user_id is None else "custom"


def _entity(
    key: str,
    row: Any,
    agent: Optional[AgentTable],
    conversations: int,
    used: dict[str, set[str]],
) -> UsageAgentEntity:
    last_day = getattr(row, "last_day", None)
    if isinstance(last_day, str):
        last_day = date.fromisoformat(last_day[:10])
    return UsageAgentEntity(
        key=key,
        agentId=agent.id if agent else None,
        name=(agent.name if agent else None) or (getattr(row, "label", None)) or _UNKNOWN_AGENT,
        icon=agent.icon if agent else None,
        kind=_kind(agent),
        engine=agent.type if agent else None,
        version=agent.version if agent else None,
        isActive=bool(agent.is_active) if agent else False,
        createdAt=agent.created_at if agent else None,
        answers=_int(getattr(row, "answers", 0)),
        conversations=conversations,
        inputTokens=_int(getattr(row, "input_tokens", 0)),
        cachedInputTokens=_int(getattr(row, "cached_tokens", 0)),
        outputTokens=_int(getattr(row, "output_tokens", 0)),
        totalTokens=_int(getattr(row, "input_tokens", 0)) + _int(getattr(row, "output_tokens", 0)),
        modelMs=_int(getattr(row, "model_ms", 0)),
        modelCalls=_int(getattr(row, "model_calls", 0)),
        toolCalls=_int(getattr(row, "tool_calls", 0)),
        detailedAnswers=_int(getattr(row, "detailed", 0)),
        detailedInputTokens=_int(getattr(row, "detailed_input", 0)),
        costMicros=_int(getattr(row, "cost_micros", 0)),
        truncatedCalls=_int(getattr(row, "truncated_calls", 0)),
        lastUsedAt=datetime.combine(last_day, time()) if isinstance(last_day, date) else None,
        subagents=sorted(used.get("subagents", set())),
        models=sorted(used.get("models", set())),
    )


async def _visible_agents(db: AsyncSession, user_id: str, agent_ids: list[str]) -> dict[str, AgentTable]:
    """The agent rows the caller may see: platform agents and their own.

    An agent another user owns is left out even if this user once ran it — the
    Usage tab never describes someone else's custom agent.
    """
    if not agent_ids:
        return {}
    rows = (await db.execute(select(AgentTable).where(AgentTable.id.in_(agent_ids)))).scalars().all()
    return {a.id: a for a in rows if a.owner_user_id is None or a.owner_user_id == user_id}


async def _conversation_counts(
    db: AsyncSession, user_id: str, range_key: str, agent_id: Optional[str] = None
) -> dict[str, int]:
    """Conversations per agent — by the agent each conversation runs on now.

    From the conversations' running totals, not from answers: an exact
    distinct count over answers would rescan them, and a conversation that
    switched agents mid-way is rare enough that "its current agent" is honest.
    """
    conv = ConversationTable
    stmt = (
        select(conv.agent_id, func.count())
        .where(conv.user_id == user_id, conv.usage_answers > 0)
        .group_by(conv.agent_id)
    )
    cutoff = _range_cutoff(range_key)
    if cutoff is not None:
        stmt = stmt.where(conv.usage_updated_at >= cutoff)
    if agent_id is not None:
        stmt = stmt.where(conv.agent_id == agent_id)
    return {str(row[0]): _int(row[1]) for row in (await db.execute(stmt)).all()}


async def list_usage_agents(db: AsyncSession, user_id: str, *, range_key: str, kind: str) -> UsageAgentList:
    """Every agent the caller has worked with in the range, as an entity:
    platform, custom (their own) or deleted, with totals and coverage-aware
    counts the client turns into per-answer comparisons."""
    first_day = _range_first_day(range_key)
    identity = _identity(_DAY).label("agent_key")
    stmt = select(identity, *_entity_columns()).where(_DAY.user_id == user_id).group_by(identity)
    if first_day is not None:
        stmt = stmt.where(_DAY.day >= first_day)
    rows = (await db.execute(stmt)).all()

    agents = await _visible_agents(db, user_id, [r.agent_id for r in rows if r.agent_id])
    conversations = await _conversation_counts(db, user_id, range_key)

    used: dict[str, dict[str, set[str]]] = defaultdict(lambda: {"subagents": set(), "models": set()})
    group_identity = _identity(_GROUP).label("agent_key")
    used_stmt = select(group_identity, _GROUP.scope, _GROUP.group_name, _GROUP.model_name).where(
        _GROUP.user_id == user_id
    ).distinct()
    if first_day is not None:
        used_stmt = used_stmt.where(_GROUP.day >= first_day)
    for r in (await db.execute(used_stmt)).all():
        bucket = used[str(r.agent_key)]
        if r.scope == "subagent":
            bucket["subagents"].add(r.group_name)
        if r.model_name:
            bucket["models"].add(r.model_name)

    items: list[UsageAgentEntity] = []
    for r in rows:
        agent_key = str(r.agent_key)
        agent = agents.get(r.agent_id) if r.agent_id else None
        if r.agent_id and agent is None:
            continue  # someone else's custom agent: never described here
        entity = _entity(agent_key, r, agent, conversations.get(str(r.agent_id), 0), used.get(agent_key, {}))
        if kind != "all" and entity.kind != kind:
            continue
        items.append(entity)
    items.sort(key=lambda e: (e.totalTokens, e.answers), reverse=True)
    return UsageAgentList(items=items[:MAX_AGENT_ENTITIES])


def _parse_agent_key(agent_key: str) -> tuple[Optional[str], Optional[str]]:
    """(agent id, deleted-agent label) from a path key; 400 on anything else."""
    if agent_key.startswith(_NAME_KEY_PREFIX):
        label = agent_key[len(_NAME_KEY_PREFIX):]
        if 0 < len(label) <= 200 and _AGENT_ID.match(label[:128]):
            return None, label
    elif _AGENT_ID.match(agent_key):
        return agent_key, None
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid agent key.")


def _from_day(table: Any, first_day: Optional[date]) -> list:
    """A range's condition on a rollup's day — none for "all time"."""
    return [table.day >= first_day] if first_day is not None else []


def _matches(table: Any, agent_id: Optional[str], label: Optional[str]):
    """Rows of one agent in a rollup: by id, or — once deleted — by its last name."""
    if agent_id:
        return table.agent_id == agent_id
    return and_(table.agent_id.is_(None), table.agent_name == label)


async def get_usage_agent(db: AsyncSession, user_id: str, agent_key: str, *, range_key: str) -> UsageAgentDetail:
    """One agent's profile over the range. 404 for an agent the caller may not
    see, or a deleted one they never used."""
    agent_id, label = _parse_agent_key(agent_key)
    agent: Optional[AgentTable] = None
    if agent_id:
        agent = (await _visible_agents(db, user_id, [agent_id])).get(agent_id)
        if agent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found.")

    first_day = _range_first_day(range_key)

    totals = (await db.execute(
        select(*_entity_columns()).where(_DAY.user_id == user_id, _matches(_DAY, agent_id, label), *_from_day(_DAY, first_day))
    )).one()
    if agent is None and not _int(totals.answers):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found.")

    group_rows = (await db.execute(
        select(
            _GROUP.scope, _GROUP.group_name, _GROUP.model_name,
            func.sum(_GROUP.calls), func.sum(_GROUP.input_tokens), func.sum(_GROUP.cached_input_tokens),
            func.sum(_GROUP.output_tokens), func.sum(_GROUP.reasoning_tokens), func.sum(_GROUP.model_ms),
            *_call_metric_sums(_GROUP),
        )
        .where(_GROUP.user_id == user_id, _matches(_GROUP, agent_id, label), *_from_day(_GROUP, first_day))
        .group_by(_GROUP.scope, _GROUP.group_name, _GROUP.model_name)
        .order_by(desc(func.sum(_GROUP.input_tokens) + func.sum(_GROUP.output_tokens)))
    )).all()
    groups = [
        UsageAgentGroup(
            scope=_scope(r[0]), agentId=agent_id if _scope(r[0]) == "main" else None,
            agentName=r[1], model=r[2] or None, calls=_int(r[3]), inputTokens=_int(r[4]),
            cachedInputTokens=_int(r[5]), outputTokens=_int(r[6]), reasoningTokens=_int(r[7]), modelMs=_int(r[8]),
            **_call_metrics(r[9:]),
        )
        for r in group_rows
    ]
    tools = await _tools(
        db, _TOOL_DAY, _TOOL_DAY.user_id == user_id, _matches(_TOOL_DAY, agent_id, label),
        *_from_day(_TOOL_DAY, first_day), limit=MAX_DETAIL_TOOL_ROWS,
    )
    used = {
        "subagents": {g.agentName for g in groups if g.scope == "subagent"},
        "models": {g.model for g in groups if g.model},
    }

    trend_days = min(RANGE_DAYS[range_key] or MAX_TREND_DAYS, MAX_TREND_DAYS)
    daily_rows = (await db.execute(
        select(_DAY.day, *_window_columns())
        .where(_DAY.user_id == user_id, _matches(_DAY, agent_id, label), _DAY.day > _today() - timedelta(days=trend_days))
        .group_by(_DAY.day)
        .order_by(_DAY.day)
    )).all()

    # Heaviest conversations: the ones running on this agent, by their running
    # totals — read off ix_conversations_user_usage_total, never a sum over
    # answers. A deleted agent has none: its conversations went with it.
    top: list[UsageAgentConversation] = []
    conversations = 0
    if agent_id:
        conversations = (await _conversation_counts(db, user_id, range_key, agent_id)).get(agent_id, 0)
        conv = ConversationTable
        top_stmt = (
            select(conv.id, conv.title, conv.usage_total_tokens, conv.usage_answers)
            .where(conv.user_id == user_id, conv.agent_id == agent_id, conv.is_private.is_(False), conv.usage_answers > 0)
            .order_by(conv.usage_total_tokens.desc(), conv.id.desc())
            .limit(TOP_CONVERSATIONS)
        )
        cutoff = _range_cutoff(range_key)
        if cutoff is not None:
            top_stmt = top_stmt.where(conv.usage_updated_at >= cutoff)
        top = [
            UsageAgentConversation(id=r.id, title=r.title, totalTokens=_int(r.usage_total_tokens), answers=_int(r.usage_answers))
            for r in (await db.execute(top_stmt)).all()
        ]

    return UsageAgentDetail(
        agent=_entity(agent_key, totals, agent, conversations, used),
        groups=groups,
        tools=tools,
        daily=[UsageDailyPoint(date=_day(r[0]), **_window(r[1:]).model_dump()) for r in daily_rows],
        topConversations=top,
    )
