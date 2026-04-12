from __future__ import annotations

import logging
import os
import sys

from observability.filters import RequestContextFilter
from observability.formatters import ConsoleFormatter, JsonFormatter


def _log_level() -> int:
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    return getattr(logging, level_name, logging.INFO)


def _build_handler() -> logging.Handler:
    handler = logging.StreamHandler(sys.stdout)
    log_format = os.getenv("LOG_FORMAT", "console").strip().lower()
    if log_format == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(ConsoleFormatter())
    handler.addFilter(RequestContextFilter())
    return handler


def configure_logging() -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(_log_level())
    root.addHandler(_build_handler())

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
