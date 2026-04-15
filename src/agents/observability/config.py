from __future__ import annotations

import atexit
import copy
import logging
import queue
import sys
from logging.handlers import QueueHandler, QueueListener

from core.configs import configs
from observability.filters import RequestContextFilter
from observability.formatters import ConsoleFormatter, JsonFormatter

_LISTENER: QueueListener | None = None
_ATEXIT_REGISTERED = False


def _log_level() -> int:
    level_name = configs.logging.level
    return getattr(logging, level_name, logging.INFO)


def _build_sink_handler() -> logging.Handler:
    handler = logging.StreamHandler(sys.stdout)
    log_format = configs.logging.format
    if log_format == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(ConsoleFormatter())
    handler.setLevel(_log_level())
    return handler


class InProcessQueueHandler(QueueHandler):
    def prepare(self, record: logging.LogRecord) -> logging.LogRecord:
        return copy.copy(record)


def _stop_listener() -> None:
    global _LISTENER
    if _LISTENER is not None:
        _LISTENER.stop()
        _LISTENER = None


def shutdown_logging() -> None:
    _stop_listener()
    logging.shutdown()


def configure_logging() -> None:
    global _LISTENER, _ATEXIT_REGISTERED
    _stop_listener()

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(_log_level())

    log_queue: queue.SimpleQueue[logging.LogRecord] = queue.SimpleQueue()
    queue_handler = InProcessQueueHandler(log_queue)
    queue_handler.setLevel(_log_level())
    queue_handler.addFilter(RequestContextFilter())
    root.addHandler(queue_handler)

    sink_handler = _build_sink_handler()
    _LISTENER = QueueListener(log_queue, sink_handler, respect_handler_level=True)
    _LISTENER.start()

    if not _ATEXIT_REGISTERED:
        atexit.register(shutdown_logging)
        _ATEXIT_REGISTERED = True

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
