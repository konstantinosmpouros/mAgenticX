from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from core.settings import settings
from observability.redaction import sanitize_for_logging


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": _timestamp(),
            "level": record.levelname,
            "service": getattr(record, "service", "rag_service"),
            "env": getattr(record, "env", "development"),
            "logger": record.name,
            "event": getattr(record, "event", record.name.split(".")[-1]),
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
            "user_id": getattr(record, "user_id", "anonymous"),
            "session_id": getattr(record, "session_id", "no-session"),
            "http_method": getattr(record, "http_method", None),
            "http_path": getattr(record, "http_path", None),
            "fields": sanitize_for_logging(getattr(record, "event_data", {}) or {}),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        parts = [
            datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            f"{record.levelname:<5}",
            getattr(record, "service", "rag_service"),
            getattr(record, "event", record.name.split(".")[-1]),
        ]
        method = getattr(record, "http_method", None)
        path = getattr(record, "http_path", None)
        if method and path:
            parts.append(f"{method} {path}")
        request_id = getattr(record, "request_id", "-")
        if request_id and request_id != "-":
            parts.append(f"req={request_id}")
        user_id = getattr(record, "user_id", "anonymous")
        if user_id and user_id != "anonymous":
            parts.append(f"user={user_id}")
        session_id = getattr(record, "session_id", "no-session")
        if session_id and session_id != "no-session":
            parts.append(f"session={session_id}")
        fields = sanitize_for_logging(getattr(record, "event_data", {}) or {})
        if isinstance(fields, dict):
            for key, value in fields.items():
                if value not in (None, "", {}, []):
                    parts.append(f"{key}={json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value}")
        line = " | ".join(parts)
        message = record.getMessage()
        if message:
            line += f" | {message}"
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def build_formatter() -> logging.Formatter:
    if settings.app.log_format.strip().lower() == "json":
        return JsonFormatter()
    return ConsoleFormatter()
