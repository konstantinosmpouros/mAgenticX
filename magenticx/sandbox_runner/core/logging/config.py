from __future__ import annotations

import logging
import sys

from core.logging.filters import RequestContextFilter
from core.logging.formatters import build_formatter
from core.settings import settings


def _log_level() -> int:
    return getattr(logging, settings.app.log_level.upper(), logging.INFO)


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
