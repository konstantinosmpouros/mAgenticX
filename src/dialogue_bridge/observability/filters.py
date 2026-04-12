from __future__ import annotations

import logging

from observability.context import get_context


class RequestContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        context = get_context()
        event_data = getattr(record, "event_data", {}) or {}
        record.request_id = context.get("request_id", "-")
        record.client_ip = context.get("client_ip", "-")
        record.http_method = context.get("http_method")
        record.http_path = context.get("http_path")
        record.user_id = getattr(record, "user_id", event_data.get("user_id", context.get("user_id", "anonymous")))
        record.session_id = getattr(record, "session_id", event_data.get("session_id", context.get("session_id", "no-session")))
        record.conversation_id = getattr(
            record,
            "conversation_id",
            event_data.get("conversation_id", context.get("conversation_id")),
        )
        record.message_id = getattr(
            record,
            "message_id",
            event_data.get("message_id", context.get("message_id")),
        )
        record.status_code = getattr(record, "status_code", context.get("status_code"))
        record.event = getattr(record, "event", None)
        record.event_data = event_data
        return True
