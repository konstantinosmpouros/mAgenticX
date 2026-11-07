"""The bridge's background loops for plan 41, started by the FastAPI lifespan.

* **Status consumer** — consumer group ``bridge`` on ``tasks:status``: each
  entry is mirrored into ``conversation_tasks`` and announced on its
  conversation channel (utils/async_tasks.py ``apply_status_entry``).
* **Outbox consumer** — the same group on ``tasks:outbox``: each entry wakes
  the orchestrator (utils/task_wakeups.py ``handle_outbox_item``), in its own
  task so a 429 backoff never stalls the stream; at most
  ``ASYNC_TASKS_WAKE_CONCURRENCY`` at once.
* **Reconcile loop** — at startup and then every
  ``ASYNC_TASKS_RECONCILE_INTERVAL_SECONDS``: queued messages a restart left
  behind, and ``GET /tasks/unnotified`` (``reconcile_once``).

**Delivery.** An entry is acked once handled. A status entry whose database
write failed is *not* acked: it stays pending for this consumer and is read
again on the next pending pass (and an entry a dead replica left pending is
claimed after ``ASYNC_TASKS_CLAIM_IDLE_MS``). Malformed entries are logged and
acked — retrying them can never succeed. Outbox entries are acked as soon as
their wake-up is scheduled: the durable outbox is the agents service's
``parent_notified_at``, which the reconcile loop re-reads.

Nothing here holds state across a restart; with one bridge process today and
consumer names per host, it also works with several.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Optional

from pydantic import ValidationError
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError

from core.logging import get_logger
from core.settings import settings
from schema import OutboxItem, TaskStatusEntry
from utils.async_tasks import AgentsTaskError, apply_status_entry
from utils.task_streams import OUTBOX_STREAM, STATUS_STREAM, StreamEntry, consumer_name, task_streams
from utils.task_wakeups import handle_outbox_item, reconcile_once

logger = get_logger(__name__)

EntryHandler = Callable[[str, Any], Awaitable[bool]]
#: Back-off after a Redis failure in a loop, seconds.
_ERROR_BACKOFF_SECONDS = 2.0


async def handle_status_entry(entry_id: str, data: Any) -> bool:
    """Mirror one status entry. True = ack it; False = leave it pending."""
    try:
        entry = TaskStatusEntry.model_validate(data)
    except ValidationError:
        logger.warning("task_status_entry_invalid", "Dropped a malformed task status entry", entry_id=entry_id)
        return True
    try:
        await apply_status_entry(entry)
    except SQLAlchemyError:
        logger.error("task_status_entry_failed", "Could not mirror a task status entry; kept pending",
                     entry_id=entry_id, task_id=entry.task.task_id, exc_info=True)
        return False
    except (RedisError, OSError):
        # The events capture failed: the status itself is still worth having.
        logger.warning("task_status_capture_failed", "Task events could not be captured; kept pending",
                       entry_id=entry_id, task_id=entry.task.task_id, exc_info=True)
        return False
    return True


class TaskConsumers:
    """Owns the plan-41 background loops (see the module doc)."""

    def __init__(self) -> None:
        self._tasks: list[asyncio.Task[None]] = []
        self._wakes: set[asyncio.Task[Any]] = set()
        self._stop = asyncio.Event()
        self._wake_slots: Optional[asyncio.Semaphore] = None

    def start(self) -> None:
        if not settings.async_tasks.enabled:
            logger.info("task_consumers_disabled", "Background-task consumers are disabled")
            return
        if self._tasks:
            return
        self._stop = asyncio.Event()
        self._wake_slots = asyncio.Semaphore(settings.async_tasks.wake_concurrency)
        consumer = consumer_name()
        self._tasks = [
            asyncio.create_task(self._stream_loop(STATUS_STREAM, consumer, handle_status_entry)),
            asyncio.create_task(self._stream_loop(OUTBOX_STREAM, consumer, self.handle_outbox_entry)),
            asyncio.create_task(self._reconcile_loop()),
        ]
        logger.info("task_consumers_started", "Background-task consumers started", consumer=consumer)

    async def stop(self) -> None:
        self._stop.set()
        for task in (*self._tasks, *self._wakes):
            task.cancel()
        await asyncio.gather(*self._tasks, *self._wakes, return_exceptions=True)
        self._tasks = []
        self._wakes.clear()

    async def handle_outbox_entry(self, entry_id: str, data: Any) -> bool:
        """Schedule one wake-up; always ack (the durable outbox is upstream)."""
        try:
            item = OutboxItem.model_validate(data)
        except ValidationError:
            logger.warning("task_outbox_entry_invalid", "Dropped a malformed task outbox entry", entry_id=entry_id)
            return True
        task = asyncio.create_task(self._wake(item))
        self._wakes.add(task)
        task.add_done_callback(self._wakes.discard)
        return True

    async def _wake(self, item: OutboxItem) -> None:
        slots = self._wake_slots or asyncio.Semaphore(1)
        async with slots:
            await handle_outbox_item(item)

    async def process(self, stream: str, entries: list[StreamEntry], handler: EntryHandler) -> int:
        """Run ``handler`` over ``entries`` and ack the ones it handled."""
        handled = 0
        for entry_id, data in entries:
            if await handler(entry_id, data):
                await task_streams.ack(stream, entry_id)
                handled += 1
        return handled

    async def _pending_pass(self, stream: str, consumer: str, handler: EntryHandler) -> None:
        """Entries given to this consumer but never acked, plus abandoned ones."""
        count = settings.async_tasks.read_count
        await self.process(stream, await task_streams.read_group(stream, consumer, pending=True, count=count,
                                                                 block_ms=None), handler)
        try:
            claimed = await task_streams.claim_abandoned(
                stream, consumer, min_idle_ms=settings.async_tasks.claim_idle_ms, count=count
            )
        except RedisError:
            claimed = []  # XAUTOCLAIM needs Redis 6.2; the pending pass still works
        await self.process(stream, claimed, handler)

    async def _stream_loop(self, stream: str, consumer: str, handler: EntryHandler) -> None:
        cfg = settings.async_tasks
        next_pending_pass = 0.0
        while not self._stop.is_set():
            try:
                if next_pending_pass <= time.monotonic():
                    await task_streams.ensure_group(stream)
                    await self._pending_pass(stream, consumer, handler)
                    next_pending_pass = time.monotonic() + cfg.claim_idle_ms / 1000
                entries = await task_streams.read_group(
                    stream, consumer, pending=False, count=cfg.read_count, block_ms=cfg.read_block_ms
                )
                await self.process(stream, entries, handler)
            except asyncio.CancelledError:
                raise
            except (RedisError, OSError):
                logger.warning("task_stream_read_failed", "Task stream read failed; retrying",
                               stream=stream, exc_info=True)
                next_pending_pass = 0.0
                await self._sleep(_ERROR_BACKOFF_SECONDS)

    async def _reconcile_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await reconcile_once()
            except asyncio.CancelledError:
                raise
            except (AgentsTaskError, SQLAlchemyError, RedisError, OSError):
                logger.error("task_reconcile_failed", "Background-task reconcile pass failed", exc_info=True)
            await self._sleep(settings.async_tasks.reconcile_interval_seconds)

    async def _sleep(self, seconds: float) -> None:
        """Sleep, but wake at once on stop."""
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass


task_consumers = TaskConsumers()
