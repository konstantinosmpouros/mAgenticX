from __future__ import annotations

import logging
import os
import sys

from observability.filters import RequestContextFilter
from observability.formatters import build_formatter


def _log_level() -> int:
    return getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)


def configure_logging() -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(_log_level())

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(_log_level())
    handler.setFormatter(build_formatter())
    handler.addFilter(RequestContextFilter())
    root.addHandler(handler)

    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
