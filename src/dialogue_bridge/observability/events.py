from __future__ import annotations

import logging
from typing import Any, Mapping


def _emit_standard_event(
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


def _default_message(event: str, message: str | None) -> str:
    if message:
        return message
    return event.replace("_", " ").capitalize()


class EventLogger:
    def __init__(self, logger: logging.Logger, *, bound_fields: Mapping[str, Any] | None = None) -> None:
        self._logger = logger
        self._bound_fields = dict(bound_fields or {})

    @property
    def raw(self) -> logging.Logger:
        return self._logger

    def bind(self, **fields: Any) -> "EventLogger":
        merged = dict(self._bound_fields)
        for key, value in fields.items():
            if value is not None:
                merged[key] = value
        return EventLogger(self._logger, bound_fields=merged)

    def _log_event(
        self,
        level: int,
        event: str,
        message: str,
        *,
        exc_info: bool = False,
        context: Mapping[str, Any] | None = None,
        **fields: Any,
    ) -> None:
        merged = dict(self._bound_fields)
        for key, value in fields.items():
            if value is not None:
                merged[key] = value
        _emit_standard_event(
            self._logger,
            level,
            event,
            _default_message(event, message),
            exc_info=exc_info,
            context=context,
            **merged,
        )

    def log(
        self,
        level: int,
        event: str,
        message: str | None = None,
        *,
        exc_info: bool = False,
        context: Mapping[str, Any] | None = None,
        **fields: Any,
    ) -> None:
        self._log_event(
            level,
            event,
            _default_message(event, message),
            exc_info=exc_info,
            context=context,
            **fields,
        )

    def debug(self, event: str, message: str | None = None, *, context: Mapping[str, Any] | None = None, **fields: Any) -> None:
        self.log(logging.DEBUG, event, message, context=context, **fields)

    def info(self, event: str, message: str | None = None, *, context: Mapping[str, Any] | None = None, **fields: Any) -> None:
        self.log(logging.INFO, event, message, context=context, **fields)

    def warning(
        self,
        event: str,
        message: str | None = None,
        *,
        context: Mapping[str, Any] | None = None,
        exc_info: bool = False,
        **fields: Any,
    ) -> None:
        self.log(logging.WARNING, event, message, context=context, exc_info=exc_info, **fields)

    def error(
        self,
        event: str,
        message: str | None = None,
        *,
        context: Mapping[str, Any] | None = None,
        exc_info: bool = False,
        **fields: Any,
    ) -> None:
        self.log(logging.ERROR, event, message, context=context, exc_info=exc_info, **fields)

    def exception(
        self,
        event: str,
        message: str | None = None,
        *,
        context: Mapping[str, Any] | None = None,
        **fields: Any,
    ) -> None:
        self.log(logging.ERROR, event, message, context=context, exc_info=True, **fields)


def get_logger(name: str) -> EventLogger:
    return EventLogger(logging.getLogger(name))


def log_event(
    logger: logging.Logger | EventLogger,
    level: int,
    event: str,
    message: str,
    *,
    exc_info: bool = False,
    context: Mapping[str, Any] | None = None,
    **fields: Any,
) -> None:
    event_logger = getattr(logger, "_log_event", None)
    if callable(event_logger):
        event_logger(level, event, message, exc_info=exc_info, context=context, **fields)
        return
    _emit_standard_event(logger, level, event, message, exc_info=exc_info, context=context, **fields)
