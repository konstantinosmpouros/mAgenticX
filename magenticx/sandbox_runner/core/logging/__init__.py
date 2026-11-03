"""Structured logging for the sandbox runner.

The same shape as every other service's ``core/logging`` (console or JSON
lines, request context, keyed-hash redaction), so the runner's audit records
travel the estate's normal log path. Re-exported for ``from core.logging import``.
"""
from core.logging.config import configure_logging
from core.logging.context import clear_context, get_context, set_context
from core.logging.events import EventLogger, get_logger
from core.logging.exception_handlers import register_exception_handlers
from core.logging.middleware import RequestLoggingMiddleware
from core.logging.redaction import hash_identifier

__all__ = [
    "EventLogger",
    "RequestLoggingMiddleware",
    "clear_context",
    "configure_logging",
    "get_context",
    "get_logger",
    "hash_identifier",
    "register_exception_handlers",
    "set_context",
]
