from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession

from observability.events import log_event


def elapsed_ms(started_at: float) -> float:
    return round((time.perf_counter() - started_at) * 1000, 2)


class LoggedOperation:
    def __init__(self, fields: dict[str, Any]) -> None:
        self._fields = fields

    def add(self, **extra: Any) -> None:
        for key, value in extra.items():
            if value is not None:
                self._fields[key] = value

    def snapshot(self) -> dict[str, Any]:
        return dict(self._fields)


@asynccontextmanager
async def logged_db_operation(
    *,
    logger: logging.Logger,
    db: AsyncSession | None,
    success_event: str | None,
    failure_event: str | None,
    success_message: str,
    failure_message: str,
    success_level: int = logging.INFO,
    failure_level: int = logging.ERROR,
    include_duration: bool = True,
    include_error: bool = True,
    **fields: Any,
) -> AsyncIterator[LoggedOperation]:
    started_at = time.perf_counter()
    operation = LoggedOperation({key: value for key, value in fields.items() if value is not None})

    try:
        yield operation
    except Exception as exc:
        if db is not None:
            await db.rollback()

        if failure_event:
            payload = operation.snapshot()
            if include_duration:
                payload["duration_ms"] = elapsed_ms(started_at)
            if include_error:
                payload["error"] = str(exc)
            log_event(logger, failure_level, failure_event, failure_message, exc_info=True, **payload)
        raise
    else:
        if success_event:
            payload = operation.snapshot()
            if include_duration:
                payload["duration_ms"] = elapsed_ms(started_at)
            log_event(logger, success_level, success_event, success_message, **payload)
