from __future__ import annotations

import logging
from typing import Any


def log_event(
    logger: logging.Logger,
    level: int,
    event: str,
    message: str,
    *,
    exc_info: bool = False,
    **fields: Any,
) -> None:
    logger.log(level, message, exc_info=exc_info, extra={"event": event, "event_data": fields})
