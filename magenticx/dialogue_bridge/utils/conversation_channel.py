"""The conversation channel (plan 41 §14.4): one Redis Stream per conversation.

What a browser watching a conversation must learn without having started it:
background-task frames (``{"type": "task", ...}``), runs the server launched
on its own (``run_started`` — a wake-up, a queued send, a scheduled fire) and
the composer queue's state (``queue``). The conversation WebSocket
(``router/tasks.py``) tails it.

**Why a stream, not pub/sub.** A socket that drops for a moment reconnects with
the last entry id it saw and loses nothing; pub/sub would drop every frame
published in the gap. And nothing lives in process memory: whichever bridge
process publishes, whichever serves the socket, and across a restart, the
stream is the one source. It is small and short-lived — capped at
``ASYNC_TASKS_CHANNEL_MAXLEN`` entries and EXPIREd
``ASYNC_TASKS_CHANNEL_TTL_SECONDS`` after its last frame — because the durable
state is in PostgreSQL (``conversation_tasks``, ``messages``,
``conversations.queued_message``); a client that was away longer re-reads that.

Publishing never raises: losing a live frame is better than failing the
status update, wake-up or run start that produced it.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Optional

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from core.cache import create_redis_client
from core.cache.client import STREAM_READ_TIMEOUT_MARGIN_SECONDS
from core.logging import get_logger
from core.settings import settings
from schema import InferenceRunOut, QueuedMessageOut, QueueFrame, RunStartedFrame, TaskFrame, TaskOut

logger = get_logger(__name__)

_KEY_PREFIX = "conversation"
_FIELD = "payload"


def channel_key(conversation_id: str) -> str:
    return f"{_KEY_PREFIX}:{conversation_id}:channel"


def _decode(value: Any) -> Any:
    return value.decode() if isinstance(value, bytes) else value


class ConversationChannel:
    """Append to and tail the per-conversation stream.

    Two pools, created lazily, like the run event log: one for ordinary
    commands and one for the blocking tail, whose socket timeout outlasts its
    block time.
    """

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._reader: aioredis.Redis | None = None
        self._lock = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is None:
                self._client = create_redis_client()
        return self._client

    async def _get_reader(self) -> aioredis.Redis:
        if self._reader is not None:
            return self._reader
        async with self._lock:
            if self._reader is None:
                self._reader = create_redis_client(
                    socket_timeout=settings.async_tasks.read_block_ms / 1000 + STREAM_READ_TIMEOUT_MARGIN_SECONDS
                )
        return self._reader

    async def publish(self, conversation_id: str, frame: dict[str, Any]) -> Optional[str]:
        """Append one frame; returns its entry id, or None when Redis failed."""
        try:
            client = await self._get_client()
            key = channel_key(conversation_id)
            entry_id = await client.xadd(
                key,
                {_FIELD: json.dumps(frame, ensure_ascii=False)},
                maxlen=settings.async_tasks.channel_maxlen,
                approximate=True,
            )
            await client.expire(key, settings.async_tasks.channel_ttl_seconds)
            return _decode(entry_id)
        except (RedisError, OSError):
            logger.warning(
                "conversation_channel_publish_failed",
                "Could not publish a conversation channel frame",
                exc_info=True,
                conversation_id=conversation_id,
                frame_type=frame.get("type"),
            )
            return None

    async def last_entry_id(self, conversation_id: str) -> str:
        """The newest entry id, or ``"0"`` for an empty channel: the cursor a
        fresh subscriber tails from (live frames only)."""
        client = await self._get_client()
        entries = await client.xrevrange(channel_key(conversation_id), count=1)
        return _decode(entries[0][0]) if entries else "0"

    async def tail(self, conversation_id: str, cursor: str) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Yield ``(entry_id, frame)`` after ``cursor``, forever.

        Never ends on its own — the socket handler cancels it when the client
        goes away. Malformed entries are skipped.
        """
        client = await self._get_reader()
        key = channel_key(conversation_id)
        while True:
            result = await client.xread({key: cursor}, count=100, block=settings.async_tasks.read_block_ms)
            for _stream, entries in result or ():
                for entry_id, fields in entries:
                    cursor = _decode(entry_id)
                    raw = fields.get(_FIELD) or fields.get(_FIELD.encode())
                    try:
                        frame = json.loads(raw) if raw else None
                    except json.JSONDecodeError:
                        frame = None
                    if isinstance(frame, dict):
                        yield cursor, frame


conversation_channel = ConversationChannel()


async def publish_task_frame(event: str, task: TaskOut) -> None:
    """A task's status change, as the conversation's tree should show it."""
    frame = TaskFrame(event=event, task=task).model_dump(mode="json")
    await conversation_channel.publish(task.conversation_id, frame)


async def publish_run_started(run: InferenceRunOut, *, from_queue: bool = False) -> None:
    """A run the client did not start (wake-up, queued send, scheduled fire):
    the UI attaches to it through the existing run socket. ``from_queue`` marks
    the queued composer message being sent."""
    frame = RunStartedFrame(run=run, from_queue=from_queue).model_dump(mode="json")
    await conversation_channel.publish(run.conversationId, frame)


async def publish_queue(conversation_id: str, queued: Optional[QueuedMessageOut]) -> None:
    """The composer queue's new state (``None`` = nothing queued)."""
    frame = QueueFrame(queued_message=queued).model_dump(mode="json")
    await conversation_channel.publish(conversation_id, frame)


async def channel_frames(
    conversation_id: str, since: Optional[str], queued: Optional[QueuedMessageOut]
) -> AsyncIterator[dict[str, Any]]:
    """The conversation socket's frames: the queue's current state first (from
    the database — the channel may have expired), then every channel frame
    after ``since`` (or, on a fresh subscribe, from now on), each with its
    ``seq`` for a later ``since``."""
    # The cursor is taken before the queue snapshot goes out, so a frame
    # published in between is tailed rather than lost.
    cursor = since or await conversation_channel.last_entry_id(conversation_id)
    yield QueueFrame(queued_message=queued).model_dump(mode="json")
    async for entry_id, frame in conversation_channel.tail(conversation_id, cursor):
        yield {**frame, "seq": entry_id}
