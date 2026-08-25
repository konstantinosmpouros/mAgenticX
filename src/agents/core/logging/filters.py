from __future__ import annotations

import logging

from core.settings import settings
from core.logging.context import get_context
from core.logging.redaction import sanitize_context_value


_SERVICE_NAME = settings.app.service_name
_APP_ENV = settings.app.env
_APP_VERSION = settings.app.version


class RequestContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        context = get_context()
        context_override = getattr(record, "context_data", {}) or {}
        if context_override:
            context = {**context, **context_override}
        event_data = getattr(record, "event_data", {}) or {}
        record.service = _SERVICE_NAME
        record.env = _APP_ENV
        record.version = _APP_VERSION
        record.request_id = sanitize_context_value("request_id", context.get("request_id", "-"))
        record.client_ip = sanitize_context_value("client_ip", context.get("client_ip", "-"))
        record.http_method = context.get("http_method")
        record.http_path = context.get("http_path")
        record.user_id = sanitize_context_value(
            "user_id",
            getattr(record, "user_id", event_data.get("user_id", context.get("user_id", "anonymous"))),
        )
        record.session_id = sanitize_context_value(
            "session_id",
            getattr(record, "session_id", event_data.get("session_id", context.get("session_id", "no-session"))),
        )
        record.conversation_id = sanitize_context_value(
            "conversation_id",
            getattr(record, "conversation_id", event_data.get("conversation_id", context.get("conversation_id"))),
        )
        record.message_id = sanitize_context_value(
            "message_id",
            getattr(record, "message_id", event_data.get("message_id", context.get("message_id"))),
        )
        record.agent_slug = sanitize_context_value(
            "agent_slug",
            getattr(record, "agent_slug", event_data.get("agent_slug", context.get("agent_slug"))),
        )
        record.thread_id = sanitize_context_value(
            "thread_id",
            getattr(record, "thread_id", event_data.get("thread_id", context.get("thread_id"))),
        )
        record.status_code = getattr(record, "status_code", context.get("status_code"))
        record.event = getattr(record, "event", None)
        record.event_data = event_data
        return True
