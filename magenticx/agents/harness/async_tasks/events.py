"""The task streams in Redis — what the bridge reads (plan 41 §14.2).

Three kinds of stream, each entry one field ``data`` holding JSON:

* ``task:{task_id}:events`` — the task's AG-UI events, exactly as the
  normalizer emits them for a top-level run; expires after the task settles;
* ``tasks:status`` — ``{"event": TASK_STARTED|TASK_STATUS|TASK_SETTLED, "task": TaskOut}``
  on every status change;
* ``tasks:outbox`` — an ``OutboxItem`` when a depth-1 task's subtree settles.

Redis is the doorbell, never the record: the task row is durable and the
bridge reconciles from ``GET /tasks/unnotified``. So a Redis failure is logged
and swallowed here — it must never fail or stall a run.

The client mirrors the bridge's (``core/cache/client.py`` there): the same URL
and password secret, and for ``rediss://`` verification against the internal
CA. It is opened lazily, on the first write, so a deployment with async
sub-agents off never connects.
"""
from __future__ import annotations

import contextlib
import json
from datetime import datetime
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from core.logging import get_logger
from core.settings import settings

logger = get_logger(__name__)

STATUS_STREAM = "tasks:status"
OUTBOX_STREAM = "tasks:outbox"
_FIELD = "data"


def _json_default(value: Any) -> Any:
    """Datetimes as ISO 8601 (what the bridge's schemas parse); anything else as text."""
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def task_events_key(task_id: str) -> str:
    """The stream of one task's AG-UI events."""
    return f"task:{task_id}:events"


def redis_tls_kwargs() -> dict[str, Any]:
    """TLS kwargs for ``rediss://``; none for plain ``redis://`` (local dev).

    Never a bare ``ssl`` key — redis-py rejects it on a connection pool;
    ``ssl_ca_certs`` both enables verification and names the trust root.
    """
    if not settings.redis.url.startswith("rediss://"):
        return {}
    return {
        "ssl_ca_certs": settings.tls.ca_cert_path,
        "ssl_cert_reqs": "required",
        "ssl_check_hostname": True,
    }


def create_redis_client() -> aioredis.Redis:
    """A client with the shared connection configuration (5 s socket timeout)."""
    password = settings.redis.password.get_secret_value() or None
    return aioredis.from_url(
        settings.redis.url,
        password=password,
        encoding="utf-8",
        decode_responses=True,
        socket_timeout=5.0,
        socket_connect_timeout=5.0,
        **redis_tls_kwargs(),
    )


class TaskStreamPublisher:
    """Writes the task streams. Every method is best effort (see module doc)."""

    def __init__(self, client: aioredis.Redis | None = None) -> None:
        self._client = client

    def _redis(self) -> aioredis.Redis:
        if self._client is None:
            self._client = create_redis_client()
        return self._client

    async def _xadd(self, key: str, data: Any, maxlen: int, *, log_event: str, **log_fields: Any) -> None:
        try:
            await self._redis().xadd(
                key, {_FIELD: json.dumps(data, default=_json_default, separators=(",", ":"))}, maxlen=maxlen, approximate=True
            )
        except (RedisError, OSError) as exc:
            logger.warning(log_event, "Could not write a task stream entry", error_type=type(exc).__name__, **log_fields)

    async def task_event(self, task_id: str, event: dict[str, Any]) -> None:
        """Append one AG-UI event to the task's own stream."""
        await self._xadd(
            task_events_key(task_id), event, settings.async_tasks.events_maxlen,
            log_event="task_event_write_failed", task_id=task_id,
        )

    async def expire_events(self, task_id: str) -> None:
        """Let a settled task's event stream expire (the bridge has copied it by then)."""
        try:
            await self._redis().expire(task_events_key(task_id), settings.async_tasks.events_ttl_seconds)
        except (RedisError, OSError) as exc:
            logger.warning("task_events_expire_failed", "Could not set a task event stream's TTL",
                           error_type=type(exc).__name__, task_id=task_id)

    async def persist_events(self, task_id: str) -> None:
        """Keep a reopened task's event stream (undo :meth:`expire_events`)."""
        try:
            await self._redis().persist(task_events_key(task_id))
        except (RedisError, OSError) as exc:
            logger.warning("task_events_persist_failed", "Could not clear a task event stream's TTL",
                           error_type=type(exc).__name__, task_id=task_id)

    async def status(self, event: str, task: dict[str, Any]) -> None:
        """One ``tasks:status`` entry: the event and the task as it now is."""
        await self._xadd(
            STATUS_STREAM, {"event": event, "task": task}, settings.async_tasks.streams_maxlen,
            log_event="task_status_write_failed", task_id=task.get("task_id"),
        )

    async def outbox(self, item: dict[str, Any]) -> None:
        """Ring the bridge's doorbell for a settled depth-1 task."""
        await self._xadd(
            OUTBOX_STREAM, item, settings.async_tasks.streams_maxlen,
            log_event="task_outbox_write_failed", task_id=item.get("task_id"),
        )

    async def aclose(self) -> None:
        if self._client is not None:
            with contextlib.suppress(RedisError, OSError):
                await self._client.aclose()
            self._client = None


__all__ = ["OUTBOX_STREAM", "STATUS_STREAM", "TaskStreamPublisher", "create_redis_client", "task_events_key"]
