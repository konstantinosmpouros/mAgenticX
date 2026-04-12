from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from typing import Any, Mapping
import logging
import time

from observability.events import log_event
from observability.operations import elapsed_ms


class StreamMetrics:
    def __init__(self, *, event_separator: bytes | None = None, started_at: float | None = None) -> None:
        self._event_separator = event_separator
        self._started_at = started_at if started_at is not None else time.perf_counter()
        self._pending = b""
        self.chunk_count = 0
        self.event_count = 0
        self.bytes_forwarded = 0
        self.first_byte_latency_ms: float | None = None

    def track(self, chunk: bytes) -> bytes:
        if self.first_byte_latency_ms is None:
            self.first_byte_latency_ms = elapsed_ms(self._started_at)

        self.chunk_count += 1
        self.bytes_forwarded += len(chunk)

        if self._event_separator is not None:
            self._pending += chunk.replace(b"\r\n", b"\n")
            while self._event_separator in self._pending:
                _, self._pending = self._pending.split(self._event_separator, 1)
                self.event_count += 1

        return chunk

    def finalize(self) -> None:
        if self._event_separator is not None and self._pending.strip():
            self.event_count += 1
            self._pending = b""

    def snapshot(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "chunk_count": self.chunk_count,
            "bytes_forwarded": self.bytes_forwarded,
            "first_byte_latency_ms": self.first_byte_latency_ms,
            "total_stream_duration_ms": elapsed_ms(self._started_at),
        }
        if self._event_separator is not None:
            payload["event_count"] = self.event_count
        return payload

    def completed_snapshot(self) -> dict[str, Any]:
        self.finalize()
        return self.snapshot()


async def iter_tracked_stream(
    source: AsyncIterable[bytes],
    metrics: StreamMetrics,
) -> AsyncIterator[bytes]:
    async for chunk in source:
        yield metrics.track(chunk)


def log_stream_outcome(
    logger: logging.Logger,
    level: int,
    event: str,
    message: str,
    *,
    metrics: StreamMetrics,
    completed: bool = False,
    context: Mapping[str, Any] | None = None,
    **fields: Any,
) -> None:
    payload = metrics.completed_snapshot() if completed else metrics.snapshot()
    log_event(logger, level, event, message, context=context, **fields, **payload)
