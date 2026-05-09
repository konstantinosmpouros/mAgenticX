import asyncio
import json
import time
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, AsyncIterator

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    AttachmentTable,
    ConversationTable,
    InferenceRunTable,
    MessageTable,
    SessionLocal,
)
from core.proxy import internal_service_headers
from core.tls import get_httpx_verify
from observability import get_logger
from schemas import ConversationSummary, InferenceRunOut, MessageOut, ToolPreference
from utils.agents import build_agent_stream_url, get_agent_by_id
from utils.conversations import _preview
from utils.inference import prepare_inference_history
from utils.validators import validate_convId_full


ACTIVE_RUN_STATUSES = {"queued", "running", "cancelling"}
TERMINAL_RUN_STATUSES = {"completed", "cancelled", "failed"}

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


def _message_payload_from_run(run: InferenceRunTable, *, error: bool = False) -> dict[str, Any]:
    return {
        "content": run.content or "",
        "reasoning_steps": deepcopy(run.thinking) or None,
        "reasoning_time_seconds": None,
        "is_error": error,
        "error_message": run.error_message,
        "raw_events": deepcopy(run.raw_events) or [],
        "plan": deepcopy(run.plan),
        "subagents": deepcopy(run.subagents),
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
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}

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

    def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        self._subscribers.setdefault(run_id, set()).add(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        subscribers = self._subscribers.get(run_id)
        if not subscribers:
            return
        subscribers.discard(queue)
        if not subscribers:
            self._subscribers.pop(run_id, None)

    async def publish(self, run_id: str, event: dict[str, Any]) -> None:
        subscribers = list(self._subscribers.get(run_id, set()))
        for queue in subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except asyncio.QueueEmpty:
                    pass

    async def _run(self, run_id: str, cancel_event: asyncio.Event) -> None:
        runtime = InferenceRunRuntime()
        try:
            async with SessionLocal() as db:
                run = await _load_run(db, run_id)
                if not run or run.status not in ACTIVE_RUN_STATUSES:
                    return
                run.status = "running"
                await db.commit()

            async with SessionLocal() as db:
                run = await _load_run(db, run_id)
                if not run:
                    return
                # Capture static run fields once so the stream loop can build
                # lightweight in-memory events without hitting the DB per chunk.
                run_meta: dict[str, Any] = {
                    "id": run.id,
                    "userId": run.user_id,
                    "conversationId": run.conversation_id,
                    "assistantMessageId": run.assistant_message_id,
                    "parentMessageId": run.parent_message_id,
                    "status": "running",
                    "messagePath": run.message_path or [],
                    "enabledTools": run.enabled_tools or [],
                    "startedAt": run.started_at.isoformat(),
                    "updatedAt": run.started_at.isoformat(),
                    "content": None,
                    "thinking": None,
                    "rawEvents": [],
                    "plan": None,
                    "subagents": None,
                    "errorMessage": None,
                    "completedAt": None,
                    "cancelRequestedAt": None,
                }
                conversation = await validate_convId_full(run.user_id, run.conversation_id, db)
                agent = await get_agent_by_id(conversation.agent_id)
                agent_url = build_agent_stream_url(agent)
                enabled_tools = run.enabled_tools or []
                history_messages, history = prepare_inference_history(
                    logger=logger,
                    messages=conversation.messages,
                    message_ids=run.message_path,
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
                        "run_config": {"configurable": {"thread_id": str(run.conversation_id)}},
                        "context": {"user_id": str(run.user_id), "conversation_id": str(run.conversation_id)},
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
    ) -> None:
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
                            return
                        runtime.apply_event(event)
                        has_events = True
                    if has_events:
                        await self._publish_runtime_event(run_id, run_meta, runtime)

    def _build_runtime_event(self, run_meta: dict[str, Any], runtime: InferenceRunRuntime) -> dict[str, Any]:
        assistant_message_id = run_meta["assistantMessageId"]
        now_iso = _now().isoformat()
        return {
            "type": "update",
            "run": {
                **run_meta,
                "content": runtime.content,
                "thinking": deepcopy(runtime.thoughts) or None,
                "plan": deepcopy(runtime.plan),
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
                "raw_events": [],
                "created_at": run_meta["startedAt"],
                "updated_at": now_iso,
                "attachments": [],
            },
            "summary": None,
        }

    async def _publish_runtime_event(self, run_id: str, run_meta: dict[str, Any], runtime: InferenceRunRuntime) -> None:
        await self.publish(run_id, self._build_runtime_event(run_meta, runtime))

    async def _publish_snapshot(self, run_id: str, event_type: str) -> None:
        async with SessionLocal() as db:
            payload = await build_run_event_payload(db, run_id, event_type)
        if payload:
            await self.publish(run_id, payload)


inference_run_manager = InferenceRunManager()


async def _load_run(db: AsyncSession, run_id: str) -> InferenceRunTable | None:
    result = await db.execute(select(InferenceRunTable).where(InferenceRunTable.id == run_id))
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
        run.status = status_value
        run.content = runtime.content
        run.thinking = deepcopy(runtime.thoughts) or None
        run.raw_events = deepcopy(runtime.raw_events) or []
        run.plan = deepcopy(runtime.plan)
        run.subagents = deepcopy(runtime.subagents)
        run.error_message = error_message
        run.completed_at = _now()
        run.updated_at = _now()

        message = await _load_message(db, run.assistant_message_id)
        if message:
            payload = _message_payload_from_run(run, error=status_value == "failed")
            message.content = payload["content"] or ("An error occurred while generating the response." if status_value == "failed" else "")
            message.reasoning_steps = payload["reasoning_steps"]
            message.reasoning_time_seconds = runtime.thinking_duration_seconds()
            message.raw_events = payload["raw_events"]
            message.plan = payload["plan"]
            message.subagents = payload["subagents"]
            message.is_error = status_value == "failed"
            message.error_message = error_message
            message.updated_at = _now()

        conversation = await db.get(ConversationTable, run.conversation_id)
        if conversation:
            if conversation.active_inference_run_id == run.id:
                conversation.active_inference_run_id = None
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


async def build_run_event_payload(db: AsyncSession, run_id: str, event_type: str) -> dict[str, Any] | None:
    run = await _load_run(db, run_id)
    if not run:
        return None
    message = await _load_message(db, run.assistant_message_id)
    conversation = await db.get(ConversationTable, run.conversation_id)
    if conversation is not None:
        await db.refresh(conversation, attribute_names=["agent"])
    return {
        "type": event_type,
        "run": InferenceRunOut.model_validate(run).model_dump(mode="json", by_alias=False),
        "message": MessageOut.model_validate(message).model_dump(mode="json", by_alias=False) if message else None,
        "summary": ConversationSummary.model_validate(conversation).model_dump(mode="json", by_alias=False) if conversation else None,
    }


async def observe_run_events(run_id: str) -> AsyncIterator[bytes]:
    async with SessionLocal() as db:
        snapshot = await build_run_event_payload(db, run_id, "snapshot")
    if snapshot:
        yield f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n".encode("utf-8")
        if snapshot.get("run", {}).get("status") in TERMINAL_RUN_STATUSES:
            return

    queue = inference_run_manager.subscribe(run_id)
    try:
        while True:
            event = await queue.get()
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")
            run_status = event.get("run", {}).get("status")
            if run_status in TERMINAL_RUN_STATUSES:
                return
    finally:
        inference_run_manager.unsubscribe(run_id, queue)


async def create_inference_run(
    *,
    db: AsyncSession,
    user_id: str,
    conversation: ConversationTable,
    parent_message_id: str,
    message_path: list[str] | None,
    enabled_tools: list[ToolPreference] | None,
) -> tuple[InferenceRunTable, MessageTable]:
    existing = await db.execute(
        select(InferenceRunTable).where(
            InferenceRunTable.conversation_id == conversation.id,
            InferenceRunTable.status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation already has an active inference run.")

    parent = next((message for message in conversation.messages if message.id == parent_message_id), None)
    if not parent:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent message does not belong to this conversation.")

    assistant_message = MessageTable(
        conversation_id=conversation.id,
        parent_message_id=parent_message_id,
        sender="ai",
        type="text",
        content="",
        raw_events=[],
    )
    db.add(assistant_message)
    await db.flush()

    resolved_path = [*(message_path or []), assistant_message.id]
    run = InferenceRunTable(
        user_id=user_id,
        conversation_id=conversation.id,
        assistant_message_id=assistant_message.id,
        parent_message_id=parent_message_id,
        status="queued",
        message_path=resolved_path,
        enabled_tools=_tool_preferences_to_json(enabled_tools),
        content="",
        thinking=None,
        raw_events=[],
    )
    db.add(run)
    await db.flush()

    conversation.active_inference_run_id = run.id
    conversation.last_message_at = _now()
    await db.commit()
    await db.refresh(run)
    loaded_message = await _load_message(db, assistant_message.id)
    return run, loaded_message or assistant_message


async def request_run_cancel(db: AsyncSession, run: InferenceRunTable) -> InferenceRunTable:
    if run.status not in ACTIVE_RUN_STATUSES:
        return run
    run.status = "cancelling"
    run.cancel_requested_at = _now()
    has_live_task = inference_run_manager.request_cancel(run.id)
    if not has_live_task:
        now = _now()
        run.status = "cancelled"
        run.completed_at = now
        run.updated_at = now
        message = await _load_message(db, run.assistant_message_id)
        if message:
            message.content = run.content or message.content or ""
            message.raw_events = run.raw_events or message.raw_events or []
        conversation = await db.get(ConversationTable, run.conversation_id)
        if conversation and conversation.active_inference_run_id == run.id:
            conversation.active_inference_run_id = None
    await db.commit()
    await db.refresh(run)
    return run


async def cleanup_orphaned_inference_runs() -> None:
    async with SessionLocal() as db:
        now = _now()
        await db.execute(
            update(InferenceRunTable)
            .where(InferenceRunTable.status.in_(ACTIVE_RUN_STATUSES))
            .values(status="failed", error_message="Inference run was interrupted by service restart.", completed_at=now, updated_at=now)
        )
        await db.execute(update(ConversationTable).where(ConversationTable.active_inference_run_id.is_not(None)).values(active_inference_run_id=None))
        await db.commit()
