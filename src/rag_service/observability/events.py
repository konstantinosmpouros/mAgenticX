from __future__ import annotations

import logging
from typing import Any


def _default_message(event: str, message: str | None) -> str:
    if message:
        return message
    return event.replace("_", " ").capitalize()


class EventLogger:
    def __init__(self, logger: logging.Logger) -> None:
        self._logger = logger

    def log(self, level: int, event: str, message: str | None = None, **fields: Any) -> None:
        self._logger.log(
            level,
            _default_message(event, message),
            extra={"event": event, "event_data": fields},
        )

    def info(self, event: str, message: str | None = None, **fields: Any) -> None:
        self.log(logging.INFO, event, message, **fields)

    def warning(self, event: str, message: str | None = None, **fields: Any) -> None:
        self.log(logging.WARNING, event, message, **fields)

    def error(self, event: str, message: str | None = None, *, exc_info: bool = False, **fields: Any) -> None:
        self._logger.log(
            logging.ERROR,
            _default_message(event, message),
            exc_info=exc_info,
            extra={"event": event, "event_data": fields},
        )

    def exception(self, event: str, message: str | None = None, **fields: Any) -> None:
        self.error(event, message, exc_info=True, **fields)


def get_logger(name: str) -> EventLogger:
    return EventLogger(logging.getLogger(name))
