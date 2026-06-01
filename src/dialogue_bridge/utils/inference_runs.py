import asyncio
import json
import time
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator

import httpx
from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    AttachmentTable,
    ConversationTable,
    MessageTable,
    SessionLocal,
)
from core.proxy import internal_service_headers
from core.settings import settings
from core.tls import get_httpx_verify
from observability import get_logger
from schemas import ConversationSummary, InferenceRunOut, MessageOut, ToolPreference
from utils.agents import build_agent_stream_url, get_agent_by_id
from utils.conversations import _preview
from utils.event_log import event_log
from utils.inference import prepare_inference_history, resolve_inference_message_path
from utils.validators import validate_convId_full

ACTIVE_RUN_STATUSES = {"queued", "running", "cancelling"}
TERMINAL_RUN_STATUSES = {"completed", "cancelled", "failed"}
MAX_ACTIVE_RUNS_PER_USER = settings.rate_limit.inference_max_active_runs
STALE_QUEUED_RUN_AFTER = timedelta(minutes=2)

logger = get_logger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _tool_preferences_to_json(items: list[ToolPreference] | None) -> list[dict[str, str]]:
    if not items:
        return []
    return [{"server_id": item.server_id, "tool_name": item.tool_name} for item in items]


def _parse_sse_bytes(buffer: str, chunk: bytes) -> tuple[str, list[dict[str, Any]]]:
    buffer += chunk.decode("utf-8", errors="ignore")
    events: list[dict[str, Any]] = []
    while "\n\n" in buffer:
        raw_event, buffer = buffer.split("\n\n", 1)
        data_lines = []
        for line in raw_event.splitlines():
            stripped = line.strip()
            if stripped.startswith("data:"):
                data_lines.append(stripped[5:].strip())
        if not data_lines:
            continue
        payload = "\n".join(data_lines).strip()
        if not payload:
            continue
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("type"):
            events.append(value)
    return buffer, events


def _message_payload_from_runtime(runtime: "InferenceRunRuntime", *, error: bool, error_message: str | None) -> dict[str, Any]:
    return {
        "content": runtime.content or "",
        "reasoning_steps": deepcopy(runtime.thoughts) or None,
        "reasoning_time_seconds": runtime.thinking_duration_seconds(),
        "is_error": error,
        "error_message": error_message,
        "raw_events": deepcopy(runtime.raw_events) or [],
        "plan": deepcopy(runtime.plan),
        "subagents": deepcopy(runtime.subagents),
    }


class InferenceRunRuntime:
    def __init__(self) -> None:
        self.content = ""
        self.thoughts: list[str] = []
        self.raw_events: list[dict[str, Any]] = []
        self.plan: dict[str, Any] | None = None
        self.subagents: dict[str, list[Any]] | None = None
        self.first_event_ts = 0.0
        self.thinking_start = 0.0
        self.thinking_end = 0.0
        self.closed_thinking_on_first_chunk = False

    def push_subagent_event(self, key: str, value: Any) -> None:
        current = self.subagents or {}
        existing = current.get(key)
        current[key] = [*(existing if isinstance(existing, list) else []), value]
        self.subagents = current

    def thinking_duration_seconds(self) -> int | None:
        if not (self.thinking_start or self.first_event_ts):
            return None
        start = self.first_event_ts or self.thinking_start
        end = self.thinking_end or time.perf_counter()
        return max(0, round(end - start))

    def apply_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if not self.first_event_ts:
            self.first_event_ts = time.perf_counter()

        if event_type == "CUSTOM":
            self.raw_events.append(event)
            name = event.get("name")
            value = event.get("value")
            if name == "PLAN_SNAPSHOT" and isinstance(value, dict):
                self.plan = value
            elif name == "TASK_SUBAGENT":
                self.push_subagent_event("tasks", value)
            elif name == "SUBAGENT_EVENT":
                self.push_subagent_event("events", value)
            elif name == "BEFORE_AGENT_EVENT":
                self.push_subagent_event("beforeAgent", value)
            elif name == "HITL_INTERRUPT":
                self.push_subagent_event("interrupts", value)
            return

        if event_type == "THINKING_START":
            self.thinking_start = time.perf_counter()
            self.thinking_end = 0.0
            return

        if event_type == "THINKING_TEXT_MESSAGE_CONTENT":
            self.thoughts.append(str(event.get("delta") or ""))
            return

        if event_type == "TOOL_CALL_START":
            name = str(event.get("toolCallName") or "tool")
            self.thoughts.append(f"[tool] {name}")
            return

        if event_type == "THINKING_END":
            self.thinking_end = time.perf_counter()
            return

        if event_type in {"TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_CONTENT"}:
            self.content += str(event.get("delta") or "")
            if not self.closed_thinking_on_first_chunk:
                self.closed_thinking_on_first_chunk = True
                self.thinking_end = time.perf_counter()


class InferenceRunManager:
    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}

    def launch(self, run_id: str) -> None:
        if run_id in self._tasks and not self._tasks[run_id].done():
            return
        cancel_event = asyncio.Event()
        self._cancel_events[run_id] = cancel_event
        task = asyncio.create_task(self._run(run_id, cancel_event))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _: (self._tasks.pop(run_id, None), self._cancel_events.pop(run_id, None)))

    def request_cancel(self, run_id: str) -> bool:
        event = self._cancel_events.get(run_id)
        if event:
            event.set()
            return True
        return False

    def has_live_task(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return bool(task and not task.done())

    async def publish(self, run_id: str, event: dict[str, Any]) -> None:
        """Append the event to the durable per-run Redis Stream.

        Subscribers consume via :func:`observe_run_events` (SSE legacy) or the
        WebSocket endpoint, both backed by the same stream. Failure to write
        is logged but never raised — losing the wire frame is preferable to
        crashing the inference run.
        """
        try:
            await event_log.append(run_id, event)
        except Exception:
            logger.error(
                "event_log_publish_failed",
                "Failed to append inference event to Redis stream",
                exc_info=True,
                run_id=run_id,
            )

    async def _run(self, run_id: str, cancel_event: asyncio.Event) -> None:
        runtime = InferenceRunRuntime()
        try:
            async with SessionLocal() as db:
                run = await _load_run(db, run_id)
                if not run or run.streaming_status not in ACTIVE_RUN_STATUSES:
                    return
                run.streaming_status = "running"
                run.updated_at = _now()
                await db.commit()

            async with SessionLocal() as db:
                run = await _load_run(db, run_id)
                if not run:
                    return
                # The owning user_id is resolved via the conversation row since
                # the assistant message itself doesn't carry user_id directly.
                conv_row = await db.get(ConversationTable, run.conversation_id)
                if not conv_row:
                    return
                user_id = conv_row.user_id
                # Reload with eager-loaded messages for the inference history builder.
                conversation = await validate_convId_full(user_id, run.conversation_id, db)
                started_at = run.streaming_started_at or run.created_at
                # Capture static run fields once so the stream loop can build
                # lightweight in-memory events without hitting the DB per chunk.
                run_meta: dict[str, Any] = {
                    "id": run.id,
                    "userId": user_id,
                    "conversationId": run.conversation_id,
                    "assistantMessageId": run.id,
                    "parentMessageId": run.parent_message_id,
                    "status": "running",
                    "messagePath": run.streaming_message_path or [],
                    "enabledTools": run.streaming_enabled_tools or [],
                    "startedAt": started_at.isoformat(),
                    "updatedAt": started_at.isoformat(),
                    "content": None,
                    "thinking": None,
                    "rawEvents": [],
                    "plan": None,
                    "subagents": None,
                    "errorMessage": None,
                    "completedAt": None,
                    "cancelRequestedAt": None,
                }
                agent = await get_agent_by_id(conversation.agent_id)
                agent_url = build_agent_stream_url(agent)
                enabled_tools = run.streaming_enabled_tools or []
                history_messages, history = prepare_inference_history(
                    logger=logger,
                    messages=conversation.messages,
                    message_ids=run.streaming_message_path,
                    enabled_tools_count=len(enabled_tools),
                )
                logger.info(
                    "inference_run_started",
                    "Detached inference run started",
                    run_id=run.id,
                    conversation_id=run.conversation_id,
                    history_messages=len(history_messages),
                )
                request_payload: dict[str, Any] = {
                    "messages": history,
                    "config": {
                        "run_config": {
                            "configurable":
                                {
                                    "thread_id": str(run.conversation_id)
                                }
                        },
                        "context":
                            {
                                "user_id": str(user_id),
                                "conversation_id": str(run.conversation_id)
                            },
                        "tools": enabled_tools or None,
                    },
                }

            # Race the stream task against the cancel event so that cancellation
            # interrupts the HTTP read immediately rather than waiting for the
            # next chunk to arrive.
            stream_task = asyncio.create_task(
                self._do_stream(run_id, run_meta, runtime, agent_url, request_payload)
            )
            cancel_waiter = asyncio.create_task(cancel_event.wait())
            done, _ = await asyncio.wait({stream_task, cancel_waiter}, return_when=asyncio.FIRST_COMPLETED)

            if cancel_waiter in done and stream_task not in done:
                stream_task.cancel()
                await asyncio.gather(stream_task, return_exceptions=True)
                await _mark_run_cancelled(run_id, runtime)
                await self._publish_snapshot(run_id, "terminal")
                return

            cancel_waiter.cancel()
            await asyncio.gather(cancel_waiter, return_exceptions=True)

            if not stream_task.cancelled():
                exc = stream_task.exception()
                if exc:
                    raise exc
                result = stream_task.result()
                if result == "failed":
                    return

            if cancel_event.is_set():
                await _mark_run_cancelled(run_id, runtime)
                await self._publish_snapshot(run_id, "terminal")
                return

            await _mark_run_completed(run_id, runtime)
            await self._publish_snapshot(run_id, "terminal")
        except asyncio.CancelledError:
            await _mark_run_cancelled(run_id, runtime)
            await self._publish_snapshot(run_id, "terminal")
        except Exception:
            logger.error("inference_run_failed", "Detached inference run failed", exc_info=True, run_id=run_id)
            await _mark_run_failed(run_id, runtime, "The agent stream ended unexpectedly.")
            await self._publish_snapshot(run_id, "terminal")
        finally:
            self._cancel_events.pop(run_id, None)

    async def _do_stream(
        self,
        run_id: str,
        run_meta: dict[str, Any],
        runtime: InferenceRunRuntime,
        agent_url: str,
        request_payload: dict[str, Any],
    ) -> str:
        sse_buffer = ""
        timeout = httpx.Timeout(connect=30.0, read=180.0, write=180.0, pool=30.0)
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            headers = internal_service_headers(None)
            headers["Accept"] = "text/event-stream"
            async with client.stream("POST", agent_url, json=request_payload, headers=headers) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    sse_buffer, events = _parse_sse_bytes(sse_buffer, chunk)
                    has_events = False
                    for event in events:
                        if event.get("type") == "RUN_ERROR":
                            await _mark_run_failed(run_id, runtime, str(event.get("message") or "Agent stream failed."))
                            await self._publish_snapshot(run_id, "terminal")
                            return "failed"
                        runtime.apply_event(event)
                        has_events = True
                    if has_events:
                        await self._publish_runtime_event(run_id, run_meta, runtime)
        return "completed"

    async def _publish_runtime_event(self, run_id: str, run_meta: dict[str, Any], runtime: InferenceRunRuntime) -> None:
        assistant_message_id = run_meta["assistantMessageId"]
        now_iso = _now().isoformat()
        event = {
            "type": "update",
            "run": {
                **run_meta,
                "content": runtime.content,
                "thinking": deepcopy(runtime.thoughts) or None,
                "rawEvents": deepcopy(runtime.raw_events) or [],
                "plan": deepcopy(runtime.plan),
                "subagents": deepcopy(runtime.subagents),
                "updatedAt": now_iso,
            },
            "message": {
                "id": assistant_message_id,
                "conversation_id": run_meta["conversationId"],
                "parent_message_id": run_meta.get("parentMessageId"),
                "sender": "ai",
                "type": "text",
                "content": runtime.content,
                "thinking": deepcopy(runtime.thoughts) or None,
                "raw_events": deepcopy(runtime.raw_events) or [],
                "plan": deepcopy(runtime.plan),
                "subagents": deepcopy(runtime.subagents),
                "created_at": run_meta["startedAt"],
                "updated_at": now_iso,
                "attachments": [],
            },
            "summary": None,
        }
        await self.publish(run_id, event)

    async def _publish_snapshot(self, run_id: str, event_type: str) -> None:
        async with SessionLocal() as db:
            payload = await build_run_event_payload(db, run_id, event_type)
        if payload:
            await self.publish(run_id, payload)
        if event_type == "terminal":
            # Stamp a TTL on the stream so reconnecting clients can still replay
            # for the configured window. After expiry Redis drops the stream and
            # the durable record stays in PostgreSQL.
            try:
                await event_log.mark_terminal(run_id)
            except Exception:
                logger.warning(
                    "event_log_mark_terminal_failed",
                    "Failed to set terminal TTL on Redis stream",
                    exc_info=True,
                    run_id=run_id,
                )


inference_run_manager = InferenceRunManager()


async def _load_run(db: AsyncSession, run_id: str) -> MessageTable | None:
    """Load the AI message that represents a streaming run.

    ``run_id`` is the assistant message ID — after the InferenceRunTable collapse
    the message row carries the streaming_* columns that used to live there.
    """
    result = await db.execute(select(MessageTable).where(MessageTable.id == run_id))
    return result.scalar_one_or_none()


async def _load_message(db: AsyncSession, message_id: str) -> MessageTable | None:
    result = await db.execute(
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(MessageTable.id == message_id)
    )
    return result.scalar_one_or_none()



async def _finish_run(run_id: str, runtime: InferenceRunRuntime, status_value: str, error_message: str | None = None) -> None:
    async with SessionLocal() as db:
        run = await _load_run(db, run_id)
        if not run:
            return
        if run.streaming_status in TERMINAL_RUN_STATUSES:
            return
        # If a cancel was requested mid-flight, normalize a "completed" verdict
        # to "cancelled" so the user-visible outcome matches their intent.
        if status_value == "completed" and (
            run.streaming_status == "cancelling" or run.streaming_cancel_requested_at is not None
        ):
            status_value = "cancelled"
            error_message = None

        is_error = status_value == "failed"
        payload = _message_payload_from_runtime(runtime, error=is_error, error_message=error_message)

        # Write streaming metadata + final content onto the single MessageTable row.
        run.streaming_status = status_value
        run.streaming_completed_at = _now()
        run.content = payload["content"] or (
            "An error occurred while generating the response." if is_error else ""
        )
        run.reasoning_steps = payload["reasoning_steps"]
        run.reasoning_time_seconds = payload["reasoning_time_seconds"]
        run.raw_events = payload["raw_events"]
        run.plan = payload["plan"]
        run.subagents = payload["subagents"]
        run.is_error = is_error
        run.error_message = error_message
        run.updated_at = _now()

        conversation = await db.get(ConversationTable, run.conversation_id)
        if conversation:
            if conversation.active_assistant_message_id == run.id:
                conversation.active_assistant_message_id = None
            preview = _preview(run.content)
            if preview:
                conversation.last_message_preview = preview
            conversation.last_message_at = _now()
            conversation.updated_at = _now()
        await db.commit()


async def _mark_run_completed(run_id: str, runtime: InferenceRunRuntime) -> None:
    await _finish_run(run_id, runtime, "completed")


async def _mark_run_cancelled(run_id: str, runtime: InferenceRunRuntime) -> None:
    await _finish_run(run_id, runtime, "cancelled")


async def _mark_run_failed(run_id: str, runtime: InferenceRunRuntime, error_message: str) -> None:
    await _finish_run(run_id, runtime, "failed", error_message)


async def mark_run_launch_failed(run_id: str) -> None:
    await _finish_run(run_id, InferenceRunRuntime(), "failed", "Inference run could not be launched.")


def build_run_out_from_message(message: MessageTable, *, user_id: str) -> InferenceRunOut:
    """Build the wire-shape :class:`InferenceRunOut` from a :class:`MessageTable`.

    After the inference_runs-table collapse the "run" is just the assistant
    message with ``streaming_*`` columns. The wire shape is preserved so the
    frontend doesn't need a parallel migration: ``id`` and ``assistantMessageId``
    are both the message ID.
    """
    started = message.streaming_started_at or message.created_at
    return InferenceRunOut(
        id=message.id,
        userId=user_id,
        conversationId=message.conversation_id,
        assistantMessageId=message.id,
        parentMessageId=message.parent_message_id,
        status=message.streaming_status or "completed",
        messagePath=message.streaming_message_path or [],
        enabledTools=message.streaming_enabled_tools or [],
        content=message.content,
        thinking=message.reasoning_steps,
        rawEvents=message.raw_events or [],
        plan=message.plan,
        subagents=message.subagents,
        errorMessage=message.error_message,
        startedAt=started,
        completedAt=message.streaming_completed_at,
        cancelRequestedAt=message.streaming_cancel_requested_at,
        updatedAt=message.updated_at,
    )


async def build_run_event_payload(db: AsyncSession, run_id: str, event_type: str) -> dict[str, Any] | None:
    run = await _load_run(db, run_id)
    if not run:
        return None
    # `_load_run` returns a bare MessageTable; reload with attachments eagerly so
    # the wire-side MessageOut serializer doesn't lazy-load mid-coroutine.
    message = await _load_message(db, run.id)
    conversation = await db.get(ConversationTable, run.conversation_id)
    if conversation is not None:
        await db.refresh(conversation, attribute_names=["agent"])
    user_id = conversation.user_id if conversation else ""
    return {
        "type": event_type,
        "run": build_run_out_from_message(run, user_id=user_id).model_dump(mode="json", by_alias=False),
        "message": MessageOut.model_validate(message).model_dump(mode="json", by_alias=False) if message else None,
        "summary": ConversationSummary.model_validate(conversation).model_dump(mode="json", by_alias=False) if conversation else None,
    }


async def observe_run_events(run_id: str, since: str | None = None) -> AsyncIterator[bytes]:
    """Yield SSE-formatted event frames for a run, sourced from the Redis stream.

    Backwards-compatible legacy SSE endpoint. The WebSocket endpoint uses
    :func:`stream_run_events` directly to send structured frames with sequence
    IDs.

    - If the run is already terminal: yields the DB snapshot once and returns.
    - Otherwise: replays the Redis stream from ``since`` (or from the beginning
      if not supplied), then live-tails until a terminal event is seen.
    """
    async with SessionLocal() as db:
        run = await _load_run(db, run_id)
        if run and run.streaming_status in TERMINAL_RUN_STATUSES:
            snapshot = await build_run_event_payload(db, run_id, "snapshot")
            if snapshot:
                yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n".encode("utf-8")
            return

    cursor = since if since else "0"
    async for _entry_id, event in event_log.read_since(
        run_id,
        cursor,
        terminal_statuses=TERMINAL_RUN_STATUSES,
    ):
        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")


SNAPSHOT_SEQ_SENTINEL = "__snapshot__"


async def stream_run_events(
    run_id: str,
    since: str | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Yield ``(seq, event)`` pairs from the run's stream for WebSocket consumers.

    Behaviour mirrors :func:`observe_run_events` but exposes the entry ID as the
    ``seq`` cursor so the client can resume after disconnect. For runs already
    in a terminal state, a single frame is yielded with the
    :data:`SNAPSHOT_SEQ_SENTINEL` marker; this seq must NOT be sent back as a
    ``since`` cursor.
    """
    async with SessionLocal() as db:
        run = await _load_run(db, run_id)
        if run and run.streaming_status in TERMINAL_RUN_STATUSES:
            snapshot = await build_run_event_payload(db, run_id, "snapshot")
            if snapshot:
                yield (SNAPSHOT_SEQ_SENTINEL, snapshot)
            return

    cursor = since if since else "0"
    async for entry_id, event in event_log.read_since(
        run_id,
        cursor,
        terminal_statuses=TERMINAL_RUN_STATUSES,
    ):
        yield (entry_id, event)


def _is_active_run_integrity_conflict(exc: IntegrityError) -> bool:
    text = str(exc.orig).lower()
    return (
        "uq_messages_one_active_stream_per_conversation" in text
        or "messages_conversation_id" in text
    )


async def _fail_stale_queued_runs_for_conversation(db: AsyncSession, conversation_id: str) -> None:
    """Reap assistant-message rows that have been stuck in ``queued`` longer than
    :data:`STALE_QUEUED_RUN_AFTER` without anyone owning the asyncio task.
    """
    cutoff = _now() - STALE_QUEUED_RUN_AFTER
    stale_result = await db.execute(
        select(MessageTable).where(
            MessageTable.conversation_id == conversation_id,
            MessageTable.streaming_status == "queued",
            MessageTable.streaming_started_at < cutoff,
        )
    )
    stale_runs = stale_result.scalars().all()
    if not stale_runs:
        return

    now = _now()
    failed_run_ids: set[str] = set()
    for run in stale_runs:
        if inference_run_manager.has_live_task(run.id):
            continue
        failed_run_ids.add(run.id)
        run.streaming_status = "failed"
        run.streaming_completed_at = now
        run.is_error = True
        run.error_message = "Inference run was queued but never launched."
        run.updated_at = now
    if not failed_run_ids:
        return
    conversation = await db.get(ConversationTable, conversation_id)
    if conversation and conversation.active_assistant_message_id in failed_run_ids:
        conversation.active_assistant_message_id = None


async def create_inference_run_record(
    *,
    db: AsyncSession,
    user_id: str,
    conversation: ConversationTable,
    parent_message_id: str,
    message_path: list[str] | None,
    enabled_tools: list[ToolPreference] | None,
) -> MessageTable:
    """Create the AI placeholder message that represents the run.

    After the inference_runs-table collapse the run *is* the assistant message —
    the returned row carries both the streaming_* lifecycle columns and the
    final content/raw_events fields once the run terminates.
    """
    await _fail_stale_queued_runs_for_conversation(db, conversation.id)

    user_active_count = await db.scalar(
        select(func.count())
        .select_from(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if user_active_count >= MAX_ACTIVE_RUNS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"You already have {MAX_ACTIVE_RUNS_PER_USER} active inference runs. Cancel one before starting a new one.",
        )

    existing = await db.execute(
        select(MessageTable).where(
            MessageTable.conversation_id == conversation.id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation already has an active inference run.")

    parent = next((message for message in conversation.messages if message.id == parent_message_id), None)
    if not parent:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent message does not belong to this conversation.")

    parent_path = resolve_inference_message_path(conversation.messages, parent_message_id, message_path)
    now = _now()
    assistant_message = MessageTable(
        conversation_id=conversation.id,
        parent_message_id=parent_message_id,
        sender="ai",
        type="text",
        content="",
        raw_events=[],
        streaming_status="queued",
        streaming_enabled_tools=_tool_preferences_to_json(enabled_tools),
        streaming_started_at=now,
    )
    db.add(assistant_message)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        if _is_active_run_integrity_conflict(exc):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation already has an active inference run.") from exc
        raise

    # The streaming message path includes the new assistant message itself so the
    # detached task can hand it to the agent as the tail of the conversation
    # history. We have to set this after flush() so the id is available.
    assistant_message.streaming_message_path = [*parent_path, assistant_message.id]

    conversation.active_assistant_message_id = assistant_message.id
    conversation.last_message_at = now
    return assistant_message


async def request_run_cancel(db: AsyncSession, run: MessageTable) -> MessageTable:
    if run.streaming_status not in ACTIVE_RUN_STATUSES:
        return run
    run.streaming_status = "cancelling"
    run.streaming_cancel_requested_at = _now()
    has_live_task = inference_run_manager.request_cancel(run.id)
    if not has_live_task:
        # No live task to interrupt — flip straight to cancelled without
        # touching content (we keep whatever the message already had).
        now = _now()
        run.streaming_status = "cancelled"
        run.streaming_completed_at = now
        run.updated_at = now
        conversation = await db.get(ConversationTable, run.conversation_id)
        if conversation and conversation.active_assistant_message_id == run.id:
            conversation.active_assistant_message_id = None
    await db.commit()
    await db.refresh(run)
    return run


async def cleanup_orphaned_inference_runs() -> None:
    """On service startup, flip every assistant-message that was mid-stream into
    ``failed`` so it doesn't appear active to hydrating clients indefinitely.
    """
    async with SessionLocal() as db:
        now = _now()
        await db.execute(
            update(MessageTable)
            .where(MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES))
            .values(
                streaming_status="failed",
                streaming_completed_at=now,
                is_error=True,
                error_message="Inference run was interrupted by service restart.",
                updated_at=now,
            )
        )
        await db.execute(
            update(ConversationTable)
            .where(ConversationTable.active_assistant_message_id.is_not(None))
            .values(active_assistant_message_id=None)
        )
        await db.commit()
