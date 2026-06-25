from __future__ import annotations

import logging

from observability.context import get_context
from observability.redaction import sanitize_context_value
from core.settings import settings


class RequestContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        context = get_context()
        record.service = "rag_service"
        record.env = settings.app.environment
        record.event = getattr(record, "event", None) or record.name.split(".")[-1]
        record.event_data = getattr(record, "event_data", {}) or {}
        record.request_id = context.get("request_id", "-")
        record.http_method = context.get("http_method")
        record.http_path = context.get("http_path")
        record.session_id = sanitize_context_value("session_id", context.get("session_id", "no-session"))
        record.user_id = sanitize_context_value("user_id", context.get("user_id", "anonymous"))
        return True
