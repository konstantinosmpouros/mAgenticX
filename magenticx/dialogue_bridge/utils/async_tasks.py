"""Background sub-agent tasks (plan 41): the bridge's mirror and its calls to
the agents service.

The agents service owns and runs every task. The bridge keeps
``conversation_tasks`` — the mirror the UI's task tree is drawn from — fed by
the ``tasks:status`` stream (utils/task_consumers.py), and proxies the user's
actions on a task (stop, answer an approval) to the agents service's internal
``/tasks`` API (§14.3). Waking the orchestrator lives in
utils/task_wakeups.py.

**Ownership.** A task is shown or touched only through a conversation the
caller owns: the mirror row carries the user, and a status entry whose
conversation does not belong to the user it names is dropped, never stored.
Every agents-service call also carries the user id, and the agents service
answers 404 for another user's task.

**Settling.** When a task settles, its event stream is read once into
``raw_events`` (coalesced exactly like a run's) so a settled node still opens
after Redis expires the stream, and its usage is booked into the per-call
usage breakdown (plan 33) — at most once per token, via ``usage_booked``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Optional
from urllib.parse import quote

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    TASK_SETTLED_STATUSES,
    ConversationTable,
    ConversationTaskTable,
    MessageTable,
    MessageUsageTable,
    SessionLocal,
)
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from schema import ActiveConversationsOut, OutboxItem, TaskOut, TaskResumeIn, TaskStatusEntry
from utils.conversation_channel import publish_task_frame
from utils.inference_runs import (
    append_coalesced,
    hitl_resolved_value,
    overall_hitl_decision,
    truncate_tool_result,
)
from utils.model_pricing import call_cost_micros
from utils.task_streams import task_streams
from utils.usage_rollups import add_answer_to_rollups

logger = get_logger(__name__)

_AGENTS_BASE_URL = settings.upstream.agents_service_url.rstrip("/")
#: The scope a task's spend is booked under in message_usage / the rollups.
SUBAGENT_SCOPE = "subagent"
_USAGE_COUNTERS = ("input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "calls", "model_latency_ms")


class AgentsTaskError(Exception):
    """The agents service's task API failed or answered something unusable."""


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(value: Optional[datetime]) -> Optional[datetime]:
    """A datetime as the naive UTC every column here stores."""
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


# ---------------------------------------------------------------------------
# The agents service's internal task API (§14.3)
# ---------------------------------------------------------------------------
def _agents_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    )


def _tasks_url(suffix: str = "") -> str:
    return f"{_AGENTS_BASE_URL}/tasks{suffix}"


def _task_url(task_id: str, suffix: str = "") -> str:
    return _tasks_url(f"/{quote(task_id, safe='')}{suffix}")


def _headers() -> dict[str, str]:
    return internal_service_headers(get_context().get("request_id"))


async def _call(method: str, url: str, **kwargs: Any) -> httpx.Response:
    """One call to the agents service. Transport errors and 5xx raise
    :class:`AgentsTaskError`; any other status is the caller's to read."""
    try:
        async with _agents_client() as client:
            response = await client.request(method, url, headers=_headers(), **kwargs)
    except httpx.HTTPError as exc:
        raise AgentsTaskError(type(exc).__name__) from exc
    if response.status_code >= 500:
        raise AgentsTaskError(f"agents service answered {response.status_code}")
    return response


def _task_from_response(response: httpx.Response) -> TaskOut:
    try:
        return TaskOut.model_validate(response.json())
    except ValueError as exc:
        raise AgentsTaskError("unusable task in the agents service's answer") from exc


async def agents_get_task(task_id: str, user_id: str) -> Optional[TaskOut]:
    """``GET /tasks/{id}?user_id=`` — None when it is not that user's."""
    response = await _call("GET", _task_url(task_id), params={"user_id": user_id})
    if response.status_code == status.HTTP_404_NOT_FOUND:
        return None
    if response.status_code != status.HTTP_200_OK:
        raise AgentsTaskError(f"agents service answered {response.status_code}")
    task = _task_from_response(response)
    return task if task.user_id == user_id else None


async def agents_list_unnotified(
    limit: int, *, user_id: Optional[str] = None, conversation_id: Optional[str] = None
) -> list[OutboxItem]:
    """``GET /tasks/unnotified`` — depth-1 tasks whose settle has not been
    handled. ``user_id`` / ``conversation_id`` narrow it (a bridge extension
    to §14.3); the result is filtered here too, so an agents service that
    ignores them is still correct. Malformed items are skipped."""
    params: dict[str, Any] = {"limit": limit}
    if user_id:
        params["user_id"] = user_id
    if conversation_id:
        params["conversation_id"] = conversation_id
    response = await _call("GET", _tasks_url("/unnotified"), params=params)
    if response.status_code != status.HTTP_200_OK:
        raise AgentsTaskError(f"agents service answered {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        raise AgentsTaskError("unusable unnotified list") from exc
    items: list[OutboxItem] = []
    for raw in body if isinstance(body, list) else ():
        try:
            item = OutboxItem.model_validate(raw)
        except ValueError:
            logger.warning("task_unnotified_item_invalid", "Skipped a malformed unnotified task item")
            continue
        if user_id and item.user_id != user_id:
            continue
        if conversation_id and item.conversation_id != conversation_id:
            continue
        items.append(item)
    return items


async def agents_mark_notified(task_id: str, user_id: str) -> bool:
    """``POST /tasks/{id}/notified`` — True once the agents service recorded it
    (a 404 means the task is gone, which is just as final)."""
    response = await _call("POST", _task_url(task_id, "/notified"), json={"user_id": user_id})
    return response.status_code in (status.HTTP_200_OK, status.HTTP_204_NO_CONTENT, status.HTTP_404_NOT_FOUND)


async def agents_cancel_scope(user_id: str, conversation_id: Optional[str] = None) -> int:
    """``POST /tasks/cancel-scope`` — stop every task of a conversation, or of
    the whole account when ``conversation_id`` is None. A 404 (an agents
    service without the task API) means there is nothing to stop."""
    body: dict[str, Any] = {"user_id": user_id}
    if conversation_id is not None:
        body["conversation_id"] = conversation_id
    response = await _call("POST", _tasks_url("/cancel-scope"), json=body)
    if response.status_code == status.HTTP_404_NOT_FOUND:
        return 0
    if response.status_code != status.HTTP_200_OK:
        raise AgentsTaskError(f"agents service answered {response.status_code}")
    try:
        cancelled = response.json().get("cancelled", 0)
    except (ValueError, AttributeError):
        cancelled = 0
    return int(cancelled) if isinstance(cancelled, int) else 0


# ---------------------------------------------------------------------------
# The mirror
# ---------------------------------------------------------------------------
def task_out_from_row(row: ConversationTaskTable) -> TaskOut:
    """A mirror row in the §14.1 wire shape."""
    return TaskOut.model_validate({
        "task_id": row.task_id,
        "conversation_id": row.conversation_id,
        "user_id": row.user_id,
        "parent_task_id": row.parent_task_id,
        "root_run_id": row.root_run_id,
        "branch_thread_id": row.branch_thread_id,
        "spawned_by_message_id": row.spawned_by_message_id,
        "depth": row.depth or 1,
        "name": row.name,
        "subagent_path": row.subagent_path,
        "description": row.description,
        "model": row.model,
        "status": row.status,
        "result_preview": row.result_preview,
        "error": row.error,
        "usage": row.usage or {},
        "started_at": row.started_at,
        "settled_at": row.settled_at,
    })


async def owned_conversation(db: AsyncSession, user_id: str, conversation_id: str) -> Optional[ConversationTable]:
    """The caller's conversation (a "Try it" trial included — its tasks are
    the trial's own), or None."""
    return (
        await db.execute(
            select(ConversationTable).where(
                ConversationTable.id == conversation_id, ConversationTable.user_id == user_id
            )
        )
    ).scalar_one_or_none()


async def get_owned_task(db: AsyncSession, user_id: str, task_id: str) -> Optional[ConversationTaskTable]:
    """The caller's mirrored task, or None (another user's task is None too)."""
    return (
        await db.execute(
            select(ConversationTaskTable).where(
                ConversationTaskTable.task_id == task_id, ConversationTaskTable.user_id == user_id
            )
        )
    ).scalar_one_or_none()


#: Conversations the sidebar's task poll returns, at most.
_ACTIVE_CONVERSATIONS_MAX = 200


async def active_conversation_ids(db: AsyncSession, user_id: str) -> ActiveConversationsOut:
    """The caller's conversations whose background tasks are still working.

    The sidebar polls this while any row spins for tasks, so a row stops (or
    starts) spinning without the conversation being open. A streaming answer
    is not counted: the run manager already tracks those."""
    rows = await db.execute(
        select(ConversationTable.id)
        .where(ConversationTable.user_id == user_id, ConversationTable.active_tasks_flag)
        .limit(_ACTIVE_CONVERSATIONS_MAX)
    )
    return ActiveConversationsOut(conversationIds=list(rows.scalars()))


async def list_conversation_tasks(db: AsyncSession, user_id: str, conversation_id: str, limit: int) -> list[TaskOut]:
    """The conversation's task tree, oldest first; 404 if it is not the caller's.
    ``limit`` is capped at ``ASYNC_TASKS_LIST_LIMIT_MAX``."""
    limit = min(limit, settings.async_tasks.list_limit_max)
    if await owned_conversation(db, user_id, conversation_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
    rows = (
        await db.execute(
            select(ConversationTaskTable)
            .where(ConversationTaskTable.conversation_id == conversation_id)
            # Parents start before their children, so this is a valid tree order.
            .order_by(
                ConversationTaskTable.started_at.asc(),
                ConversationTaskTable.created_at.asc(),
                ConversationTaskTable.task_id.asc(),
            )
            .limit(limit)
        )
    ).scalars()
    return [task_out_from_row(row) for row in rows]


async def upsert_task_mirror(db: AsyncSession, task: TaskOut) -> Optional[ConversationTaskTable]:
    """Write a task's current state into the mirror (in the caller's transaction).

    Refuses — returns None and stores nothing — a task whose conversation does
    not exist or does not belong to the user the task names: the agents
    service is trusted, but a mirror row is what ownership checks read, so it
    must never be written across users. Bookkeeping columns (``raw_events``,
    ``usage_booked``, ``notified_at``) are left alone.
    """
    conversation = await db.get(ConversationTable, task.conversation_id)
    if conversation is None or conversation.user_id != task.user_id:
        logger.warning(
            "task_mirror_refused",
            "Refused to mirror a task whose conversation is not its user's",
            task_id=task.task_id,
            conversation_id=task.conversation_id,
        )
        return None
    row = await db.get(ConversationTaskTable, task.task_id)
    if row is None:
        row = ConversationTaskTable(task_id=task.task_id, conversation_id=task.conversation_id, user_id=task.user_id)
        db.add(row)
    elif row.user_id != task.user_id or row.conversation_id != task.conversation_id:
        # A task id never moves between conversations or users.
        logger.warning("task_mirror_identity_mismatch", "Refused a task update that changes its owner",
                       task_id=task.task_id)
        return None
    row.parent_task_id = task.parent_task_id
    row.root_run_id = task.root_run_id
    row.branch_thread_id = task.branch_thread_id
    row.spawned_by_message_id = task.spawned_by_message_id
    row.depth = task.depth
    row.name = task.name
    row.subagent_path = task.subagent_path
    row.description = task.description
    row.model = task.model
    row.status = task.status
    row.result_preview = task.result_preview
    row.error = task.error
    row.usage = task.usage.model_dump()
    row.started_at = _naive_utc(task.started_at)
    row.settled_at = _naive_utc(task.settled_at)
    row.updated_at = _now()
    if not task.settled:
        # Re-opened (the orchestrator continued it): a new settle will need a
        # new wake-up, and a new events capture.
        row.notified_at = None
    elif row.notified_at is not None and row.settled_at is not None and row.settled_at > row.notified_at:
        # A settle newer than the last handling is a new outcome (the task was
        # re-opened and finished again, its "running" entry missed or late):
        # it must wake the orchestrator, not be skipped as handled.
        row.notified_at = None
    return row


# ---------------------------------------------------------------------------
# Settling: events capture and usage
# ---------------------------------------------------------------------------
async def capture_task_events(task_id: str) -> list[dict[str, Any]]:
    """Read a settled task's whole event stream, coalesced like a run's log.

    Bounded by ``ASYNC_TASKS_RAW_EVENTS_MAX``: past it the oldest events are
    dropped behind one ``TASK_EVENTS_TRUNCATED`` marker. An empty list when the
    stream is gone (Redis restarted, or the TTL ran out before the bridge saw
    the settle).
    """
    log: list[dict[str, Any]] = []
    cursor = "0"
    seq = 0
    while True:
        page = await task_streams.task_events_after(task_id, cursor)
        if not page:
            break
        for entry_id, event in page:
            cursor = entry_id
            if isinstance(event, dict) and event.get("type"):
                if event.get("type") == "TOOL_CALL_RESULT":
                    event = truncate_tool_result(event)
                # Numbered like a run's stored log, so the drill-down dedupes
                # the same way when it hydrates from it.
                seq += 1
                append_coalesced(log, {**event, "seq": seq})
        if len(page) < 500:
            break
    limit = settings.async_tasks.raw_events_max
    if len(log) > limit:
        dropped = len(log) - (limit - 1)
        log = [{"type": "CUSTOM", "name": "TASK_EVENTS_TRUNCATED", "value": {"dropped": dropped}}, *log[dropped:]]
    return log


def _usage_delta(task: TaskOut, booked: Any) -> dict[str, int]:
    """What the task spent since the last booking (never negative)."""
    current = task.usage.model_dump()
    previous = booked if isinstance(booked, dict) else {}
    return {key: max(int(current.get(key) or 0) - int(previous.get(key) or 0), 0) for key in _USAGE_COUNTERS}


async def book_task_usage(db: AsyncSession, row: ConversationTaskTable, task: TaskOut) -> None:
    """Add a settled task's new spend to the usage breakdown (plan 33).

    One ``message_usage`` row per booking, scope ``subagent``, attributed to
    the conversation, the main agent of the answer that launched the tree
    (``spawned_by_message_id``) and the task's ``subagent_path`` — then the
    conversation's totals and the user's daily rollups, exactly where an
    in-run sub-agent's spend went before plan 41. Only the delta since the
    last booking is added, so a re-opened task or a repeated settle entry is
    never counted twice. Skipped when the launching answer is not in this
    conversation (nothing to attribute it to).
    """
    delta = _usage_delta(task, row.usage_booked)
    if not any(delta[key] for key in ("input_tokens", "output_tokens")):
        return
    message = await db.get(MessageTable, task.spawned_by_message_id) if task.spawned_by_message_id else None
    conversation = await db.get(ConversationTable, task.conversation_id)
    if message is None or conversation is None or message.conversation_id != task.conversation_id:
        logger.warning("task_usage_unattributed", "A task's usage had no answer to book it under",
                       task_id=task.task_id)
        return
    calls = delta["calls"] or 1
    cost = call_cost_micros(task.model, delta["input_tokens"], delta["cached_input_tokens"], delta["output_tokens"])
    created_at = _naive_utc(task.settled_at) or _now()
    group_name = (task.subagent_path or task.name)[:200]
    db.add(
        MessageUsageTable(
            message_id=message.id,
            conversation_id=conversation.id,
            user_id=conversation.user_id,
            agent_id=message.agent_id,
            main_agent_name=message.agent_name,
            scope=SUBAGENT_SCOPE,
            agent_name=group_name,
            model_name=task.model,
            calls=calls,
            input_tokens=delta["input_tokens"],
            cached_input_tokens=delta["cached_input_tokens"],
            output_tokens=delta["output_tokens"],
            reasoning_tokens=delta["reasoning_tokens"],
            model_latency_ms=delta["model_latency_ms"],
            cost_micros=cost or 0,
            unpriced_calls=calls if cost is None else 0,
            created_at=created_at,
        )
    )
    table = ConversationTable
    conversation.usage_input_tokens = table.usage_input_tokens + delta["input_tokens"]
    conversation.usage_cached_tokens = table.usage_cached_tokens + delta["cached_input_tokens"]
    conversation.usage_output_tokens = table.usage_output_tokens + delta["output_tokens"]
    conversation.usage_total_tokens = table.usage_total_tokens + delta["input_tokens"] + delta["output_tokens"]
    conversation.usage_model_calls = table.usage_model_calls + calls
    conversation.usage_model_ms = table.usage_model_ms + delta["model_latency_ms"]
    conversation.usage_cost_micros = table.usage_cost_micros + (cost or 0)
    conversation.usage_updated_at = _now()
    await add_answer_to_rollups(
        db,
        user_id=conversation.user_id,
        day=created_at.date(),
        agent_id=message.agent_id,
        agent_name=message.agent_name,
        # Spend only: a task is part of an answer already counted, never an answer.
        answer={
            "input_tokens": delta["input_tokens"],
            "cached_input_tokens": delta["cached_input_tokens"],
            "output_tokens": delta["output_tokens"],
            "reasoning_tokens": delta["reasoning_tokens"],
            "model_ms": delta["model_latency_ms"],
            "model_calls": calls,
            "cost_micros": cost or 0,
            "unpriced_calls": calls if cost is None else 0,
        },
        groups=[{
            "scope": SUBAGENT_SCOPE,
            "group_name": group_name,
            "model_name": task.model or "",
            "calls": calls,
            "input_tokens": delta["input_tokens"],
            "cached_input_tokens": delta["cached_input_tokens"],
            "output_tokens": delta["output_tokens"],
            "reasoning_tokens": delta["reasoning_tokens"],
            "model_ms": delta["model_latency_ms"],
            "cost_micros": cost or 0,
            "unpriced_calls": calls if cost is None else 0,
        }],
    )
    row.usage_booked = task.usage.model_dump()


async def apply_status_entry(
    entry: TaskStatusEntry, *, session_factory: Optional[Callable[[], AsyncSession]] = None
) -> Optional[TaskOut]:
    """Mirror one ``tasks:status`` entry and announce it on the conversation.

    On a settle the task's events are captured and its usage booked in the
    same transaction as the status. Returns the mirrored task, or None when it
    was refused (not the user's conversation). Database errors propagate — the
    consumer then leaves the entry pending, to be tried again.
    """
    task = entry.task
    events = await capture_task_events(task.task_id) if task.settled else None
    async with (session_factory or SessionLocal)() as db:
        row = await upsert_task_mirror(db, task)
        if row is None:
            await db.rollback()
            return None
        if task.settled:
            if events:
                row.raw_events = events
            await book_task_usage(db, row, task)
        await db.commit()
    await publish_task_frame(entry.event, task)
    return task


# ---------------------------------------------------------------------------
# The user's actions on a task (routes)
# ---------------------------------------------------------------------------
async def _authorised_task(db: AsyncSession, user_id: str, task_id: str) -> TaskOut:
    """The caller's task: the mirror first, else the agents service (a task
    the status stream has not delivered yet). 404 for anything else."""
    row = await get_owned_task(db, user_id, task_id)
    if row is not None:
        return task_out_from_row(row)
    try:
        task = await agents_get_task(task_id, user_id)
    except AgentsTaskError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The task service is unavailable.") from exc
    if task is None or await owned_conversation(db, user_id, task.conversation_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found.")
    return task


async def _task_action(db: AsyncSession, user_id: str, task_id: str, suffix: str, body: dict[str, Any]) -> TaskOut:
    """Proxy one action to the agents service and mirror the task it returns."""
    await _authorised_task(db, user_id, task_id)
    try:
        response = await _call("POST", _task_url(task_id, suffix), json={"user_id": user_id, **body})
    except AgentsTaskError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The task service is unavailable.") from exc
    if response.status_code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found.")
    if response.status_code == status.HTTP_409_CONFLICT:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The task is not in a state that allows this.")
    if response.status_code != status.HTTP_200_OK:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The task service refused the request.")
    try:
        task = _task_from_response(response)
    except AgentsTaskError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The task service answered badly.") from exc
    if task.user_id != user_id or task.task_id != task_id:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The task service answered badly.")
    if await upsert_task_mirror(db, task) is not None:
        await db.commit()
    return task


async def cancel_task_for_user(db: AsyncSession, user_id: str, task_id: str) -> TaskOut:
    """The Stop button: cancel the task and its whole subtree. A stop by the
    user does not wake the orchestrator (plan 41 D8)."""
    task = await _task_action(db, user_id, task_id, "/cancel", {"reason": "user"})
    logger.info("task_cancel_requested", "Background task stop requested", task_id=task_id)
    return task


def _resume_value(payload: TaskResumeIn) -> dict[str, Any]:
    """One decision in the agents-service ``/resume`` item shape (as a run's)."""
    return {
        "decision": payload.decision,
        "reason": payload.reason,
        "value": payload.value,
        "decisions": [d.model_dump() for d in payload.decisions] if payload.decisions else None,
    }


async def resume_task_for_user(db: AsyncSession, user_id: str, task_id: str, payload: TaskResumeIn) -> TaskOut:
    """An approval decision for a ``waiting`` task (plan 41 §3.8)."""
    resume_item = _resume_value(payload)
    task = await _task_action(db, user_id, task_id, "/resume", {"decisions": {payload.interruptId: resume_item}})
    # The same resolved marker a run's log gets (inference_runs), written into
    # the task's own event stream: without it the drill-down keeps showing the
    # gated tool as "Needs approval" after the task resumed and even settled.
    resume_payload = {"interrupt_id": payload.interruptId, **resume_item}
    marker = {
        "type": "CUSTOM",
        "name": "BRIDGE_HITL_RESOLVED",
        "value": hitl_resolved_value(resume_payload, overall_hitl_decision(resume_payload)),
        "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
    }
    try:
        await task_streams.append_task_event(task_id, marker)
    except Exception as exc:  # noqa: BLE001 - the decision is already applied; the marker is display state
        logger.warning("task_hitl_marker_failed", "Could not record the task approval marker",
                       task_id=task_id, error_type=type(exc).__name__)
    logger.info("task_resume_requested", "Background task approval sent", task_id=task_id,
                decision=payload.decision)
    return task


# ---------------------------------------------------------------------------
# One task's live events (the drill-down socket)
# ---------------------------------------------------------------------------
async def stream_task_events(
    user_id: str,
    task_id: str,
    since: Optional[str],
    *,
    session_factory: Optional[Callable[[], AsyncSession]] = None,
) -> AsyncIterator[dict[str, Any]]:
    """The frames of ``/tasks/{user_id}/{task_id}/ws`` (§14.4).

    ``snapshot`` first — the task, plus its stored ``events`` when it has
    settled and no ``since`` was given (the Redis stream may be gone) — then
    one ``event`` frame per live event with its stream id as ``seq``, then
    ``terminal`` once the task has settled and every event is out. The caller
    has checked ownership.
    """
    async def load() -> Optional[ConversationTaskTable]:
        async with (session_factory or SessionLocal)() as db:
            return await get_owned_task(db, user_id, task_id)

    row = await load()
    if row is None:
        return
    snapshot: dict[str, Any] = {"type": "snapshot", "task": task_out_from_row(row).model_dump(mode="json")}
    stored = row.raw_events if isinstance(row.raw_events, list) else None
    if row.status in TASK_SETTLED_STATUSES and since is None and stored is not None:
        yield {**snapshot, "events": stored}
        yield {"type": "terminal", "status": row.status}
        return
    yield snapshot

    cursor = since or "0"
    block_ms = settings.async_tasks.task_ws_block_ms
    while True:
        entries = await task_streams.task_events_wait(task_id, cursor, block_ms=block_ms)
        for entry_id, event in entries:
            cursor = entry_id
            if isinstance(event, dict):
                yield {"type": "event", "seq": entry_id, "event": event}
        if entries:
            continue
        # Quiet: has it settled? Then send what is left and close.
        row = await load()
        if row is None:
            return
        if row.status in TASK_SETTLED_STATUSES:
            while page := await task_streams.task_events_after(task_id, cursor):
                for entry_id, event in page:
                    cursor = entry_id
                    if isinstance(event, dict):
                        yield {"type": "event", "seq": entry_id, "event": event}
            yield {"type": "terminal", "status": row.status}
            return
