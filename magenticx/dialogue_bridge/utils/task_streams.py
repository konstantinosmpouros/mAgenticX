"""Reading the agents service's task streams in Redis (plan 41 §14.2).

The agents service writes three kinds of stream; the bridge only reads them:

* ``tasks:status`` — every task status change, consumed by the consumer
  group ``bridge`` into the ``conversation_tasks`` mirror;
* ``tasks:outbox`` — the doorbell rung when a depth-1 task's subtree settles,
  consumed by the same group to wake the orchestrator;
* ``task:{task_id}:events`` — one task's AG-UI events, read (never consumed)
  by the drill-down socket and, when the task settles, into the mirror's
  ``raw_events``.

Every entry carries one field, ``data``, holding JSON. The key names and the
group name are the cross-service contract, so they are constants, not
settings. Entry ids and field names are decoded whether the client returns
``str`` or ``bytes`` (fakeredis ignores ``decode_responses`` for stream reads).
"""
from __future__ import annotations

import asyncio
import json
import socket
from typing import Any, Optional

import redis.asyncio as aioredis
from redis.exceptions import ResponseError

from core.cache import create_redis_client
from core.cache.client import STREAM_READ_TIMEOUT_MARGIN_SECONDS
from core.settings import settings

STATUS_STREAM = "tasks:status"
OUTBOX_STREAM = "tasks:outbox"
CONSUMER_GROUP = "bridge"
_FIELD = "data"

#: One stream entry: its id and the decoded JSON of its ``data`` field
#: (None when the field is missing or not JSON — a poison entry to ack).
StreamEntry = tuple[str, Optional[Any]]


def task_events_key(task_id: str) -> str:
    return f"task:{task_id}:events"


def consumer_name() -> str:
    """This process's consumer name: configured, else the host name (unique
    per container, so overlapping replicas never share pending entries)."""
    return settings.async_tasks.consumer_name or socket.gethostname() or "bridge"


def _decode(value: Any) -> Any:
    return value.decode() if isinstance(value, bytes) else value


def _parse_entries(entries: Any) -> list[StreamEntry]:
    parsed: list[StreamEntry] = []
    for entry_id, fields in entries or ():
        raw = None
        if isinstance(fields, dict):
            raw = fields.get(_FIELD)
            if raw is None:
                raw = fields.get(_FIELD.encode())
        try:
            data = json.loads(_decode(raw)) if raw is not None else None
        except (json.JSONDecodeError, TypeError):
            data = None
        parsed.append((_decode(entry_id), data))
    return parsed


class TaskStreams:
    """The bridge's Redis access to the task streams.

    Two pools, created lazily: ordinary commands, and blocking reads (whose
    socket timeout outlasts the block time).
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
                block_ms = max(settings.async_tasks.read_block_ms, settings.async_tasks.task_ws_block_ms)
                self._reader = create_redis_client(socket_timeout=block_ms / 1000 + STREAM_READ_TIMEOUT_MARGIN_SECONDS)
        return self._reader

    async def ensure_group(self, stream: str) -> None:
        """Create the ``bridge`` group (from the stream's start, so a first
        boot reads the backlog — every handler is idempotent). Exists already
        on every later boot."""
        client = await self._get_client()
        try:
            await client.xgroup_create(stream, CONSUMER_GROUP, id="0", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def read_group(
        self, stream: str, consumer: str, *, pending: bool, count: int, block_ms: Optional[int]
    ) -> list[StreamEntry]:
        """New entries for this consumer (``pending=False``), or the ones it
        was given but never acked (``pending=True``, never blocks)."""
        client = await self._get_reader() if block_ms and not pending else await self._get_client()
        result = await client.xreadgroup(
            CONSUMER_GROUP,
            consumer,
            {stream: "0" if pending else ">"},
            count=count,
            block=None if pending else block_ms,
        )
        entries: list[StreamEntry] = []
        for _stream, stream_entries in result or ():
            entries.extend(_parse_entries(stream_entries))
        return entries

    async def ack(self, stream: str, entry_id: str) -> None:
        client = await self._get_client()
        await client.xack(stream, CONSUMER_GROUP, entry_id)

    async def claim_abandoned(self, stream: str, consumer: str, *, min_idle_ms: int, count: int) -> list[StreamEntry]:
        """Take over entries another consumer left pending (a replica that
        died mid-deploy), so they are processed here."""
        client = await self._get_client()
        result = await client.xautoclaim(stream, CONSUMER_GROUP, consumer, min_idle_time=min_idle_ms, count=count)
        # [next_cursor, entries, (deleted ids)] — only the entries matter.
        claimed = result[1] if isinstance(result, (list, tuple)) and len(result) > 1 else []
        return _parse_entries(claimed)

    async def task_events_after(self, task_id: str, cursor: str, *, count: int = 500) -> list[StreamEntry]:
        """A page of a task's events strictly after ``cursor`` (``"0"`` = from
        the start), oldest first. Never blocks."""
        client = await self._get_client()
        start = "-" if cursor in ("", "0", "0-0") else f"({cursor}"
        return _parse_entries(await client.xrange(task_events_key(task_id), min=start, max="+", count=count))

    async def append_task_event(self, task_id: str, event: dict[str, Any]) -> str:
        """Append one AG-UI event to a task's own event stream, in the agents
        service's entry shape (field ``data`` = the event JSON).

        The agents service writes the task's model events; the bridge writes
        only what it alone knows — the ``BRIDGE_HITL_RESOLVED`` marker of an
        approval answered from the drill-down — so a live panel and a reload
        both stop offering an approval that was already decided.
        """
        client = await self._get_client()
        entry_id = await client.xadd(
            task_events_key(task_id),
            {"data": json.dumps(event)},
            maxlen=settings.redis.stream_maxlen,
            approximate=True,
        )
        return _decode(entry_id)

    async def task_events_wait(self, task_id: str, cursor: str, *, block_ms: int) -> list[StreamEntry]:
        """The next events after ``cursor``, blocking up to ``block_ms``."""
        client = await self._get_reader()
        result = await client.xread({task_events_key(task_id): cursor or "0"}, count=200, block=block_ms)
        entries: list[StreamEntry] = []
        for _stream, stream_entries in result or ():
            entries.extend(_parse_entries(stream_entries))
        return entries


task_streams = TaskStreams()
