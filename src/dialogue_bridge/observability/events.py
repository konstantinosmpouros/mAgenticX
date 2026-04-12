from __future__ import annotations

import logging
from typing import Any, Mapping


def log_event(
    logger: logging.Logger,
    level: int,
    event: str,
    message: str,
    *,
    exc_info: bool = False,
    context: Mapping[str, Any] | None = None,
    **fields: Any,
) -> None:
    extra = {"event": event, "event_data": fields}
    if context is not None:
        extra["context_data"] = dict(context)
    logger.log(level, message, exc_info=exc_info, extra=extra)
