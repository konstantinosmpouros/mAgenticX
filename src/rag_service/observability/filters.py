from __future__ import annotations

import logging
import os

from observability.context import get_context


class RequestContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        context = get_context()
        record.service = "rag_service"
        record.env = os.getenv("ENVIRONMENT", "development")
        record.event = getattr(record, "event", None) or record.name.split(".")[-1]
        record.event_data = getattr(record, "event_data", {}) or {}
        record.request_id = context.get("request_id", "-")
        record.http_method = context.get("http_method")
        record.http_path = context.get("http_path")
        return True
