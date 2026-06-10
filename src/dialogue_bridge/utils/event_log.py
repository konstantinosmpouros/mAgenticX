"""Per-run append-only event log backed by Redis Streams.

Each inference run gets its own stream at ``inference:run:{run_id}:events``.
Entries store a single ``payload`` field holding the JSON-serialized event.
The stream is capped at a configurable MAXLEN (default 5000) and gets an
EXPIRE applied once the run reaches a terminal state, so reconnecting
clients within the TTL window can still replay missed events from any
``since`` cursor.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import redis.asyncio as aioredis

from core.settings import settings
from observability import get_logger


logger = get_logger(__name__)


def _stream_key(run_id: str) -> str:
    return f"inference:run:{run_id}:events"


class RedisEventLog:
    """Thin wrapper over Redis Streams for inference run events.

    Single shared connection pool per process; created lazily on first use.
    """

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._lock = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is None:
                password = settings.redis.password.get_secret_value() or None
                self._client = aioredis.from_url(
                    settings.redis.url,
                    password=password,
                    encoding="utf-8",
                    decode_responses=True,
                )
        return self._client

    async def append(self, run_id: str, event: dict[str, Any]) -> str:
        """Append an event to the run's stream. Returns the Redis entry ID
        (e.g. ``"1717276800123-0"``) which clients use as the ``seq`` cursor
        for resume on reconnect.
        """
        client = await self._get_client()
        payload = json.dumps(event, ensure_ascii=False)
        entry_id = await client.xadd(
            _stream_key(run_id),
            {"payload": payload},
            maxlen=settings.redis.stream_maxlen,
            approximate=True,
        )
        return entry_id

    async def read_since(
        self,
        run_id: str,
        since: str | None,
        *,
        terminal_statuses: set[str],
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Yield ``(entry_id, event)`` pairs from the run's stream.

        - ``since`` is the last-seen entry ID. ``None`` or empty starts from
          the beginning of the stream (replay full backlog).
        - Blocks on ``XREAD BLOCK`` waiting for new events. Returns when a
          terminal event is seen (status in ``terminal_statuses``) or when
          ``cancel_event`` is set.
        """
        client = await self._get_client()
        key = _stream_key(run_id)
        cursor = since if since else "0"
        while True:
            if cancel_event is not None and cancel_event.is_set():
                return
            result = await client.xread(
                {key: cursor},
                count=100,
                block=settings.redis.read_block_ms,
            )
            if not result:
                # XREAD timed out without new events; loop and check cancel.
                continue
            for _stream_name, entries in result:
                for entry_id, fields in entries:
                    payload_raw = fields.get("payload")
                    if not payload_raw:
                        cursor = entry_id
                        continue
                    try:
                        payload = json.loads(payload_raw)
                    except json.JSONDecodeError:
                        cursor = entry_id
                        continue
                    yield entry_id, payload
                    cursor = entry_id
                    run_status = (
                        payload.get("run", {}).get("status")
                        if isinstance(payload, dict)
                        else None
                    )
                    if run_status in terminal_statuses:
                        return

    async def mark_terminal(self, run_id: str) -> None:
        """Apply an EXPIRE to the stream so reconnects within the TTL window
        can still replay events. After expiry Redis drops the stream entirely;
        the durable record is kept in PostgreSQL (``InferenceRunTable``).
        """
        client = await self._get_client()
        await client.expire(_stream_key(run_id), settings.redis.terminal_ttl_seconds)

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception:  # noqa: BLE001 — best-effort cleanup on shutdown
                logger.warning("redis_close_failed", "Redis client close failed", exc_info=True)
            finally:
                self._client = None


event_log = RedisEventLog()
