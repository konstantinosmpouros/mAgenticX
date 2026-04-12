from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from observability.redaction import sanitize_for_logging


def _resolve_timezone():
    configured = (os.getenv("LOG_TIMEZONE") or os.getenv("TZ") or "Europe/Athens").strip()
    if configured:
        try:
            return ZoneInfo(configured)
        except Exception:
            return timezone.utc
    return datetime.now().astimezone().tzinfo or timezone.utc


_LOG_TZ = _resolve_timezone()


def _timestamp() -> str:
    return datetime.now(_LOG_TZ).isoformat(timespec="milliseconds")


def _console_timestamp() -> str:
    return datetime.now(_LOG_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")


def _short_logger_name(name: str) -> str:
    return name.split(".")[-1]


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": _timestamp(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        for key in (
            "event",
            "request_id",
            "client_ip",
            "http_method",
            "http_path",
            "user_id",
            "session_id",
            "conversation_id",
            "message_id",
            "status_code",
        ):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value

        event_data = getattr(record, "event_data", None) or {}
        if event_data:
            payload["fields"] = sanitize_for_logging(event_data)

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=False)


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        event_data = getattr(record, "event_data", None) or {}
        event_name = getattr(record, "event", None) or _short_logger_name(record.name)

        parts = [
            _console_timestamp(),
            f"{record.levelname:<5}",
            f"{event_name:<24}",
        ]

        method = getattr(record, "http_method", None)
        path = getattr(record, "http_path", None)
        if method and path:
            parts.append(f"{method} {path}")

        status_code = getattr(record, "status_code", None)
        if status_code is not None:
            parts.append(str(status_code))

        event_fields = dict(event_data)
        duration_ms = event_fields.pop("duration_ms", None)
        if duration_ms is not None:
            parts.append(f"{duration_ms:.2f}ms")

        message = record.getMessage()
        if message and message not in {"HTTP request started", "HTTP request completed"}:
            parts.append(message)

        context_parts: list[str] = []
        for label, attr in (
            ("req", "request_id"),
            ("user", "user_id"),
            ("session", "session_id"),
            ("conv", "conversation_id"),
            ("msg", "message_id"),
        ):
            value = getattr(record, attr, None)
            if value is not None:
                context_parts.append(f"{label}={value}")

        sanitized = sanitize_for_logging(event_fields)
        if isinstance(sanitized, dict):
            for key in (
                "query",
                "response_class",
                "content_type",
                "agent_id",
                "agent_url",
                "user_id",
                "session_id",
                "conversation_id",
                "message_id",
            ):
                value = sanitized.pop(key, None)
                if value not in (None, "", {}):
                    if key not in {"user_id", "session_id", "conversation_id", "message_id"}:
                        context_parts.append(f"{key}={value}")

            for key, value in sanitized.items():
                if value not in (None, "", {}, []):
                    if isinstance(value, (dict, list)):
                        context_parts.append(f"{key}=" + json.dumps(value, ensure_ascii=False, sort_keys=True))
                    else:
                        context_parts.append(f"{key}={value}")

        line = " | ".join(parts)
        if context_parts:
            line += " | " + " ".join(context_parts)

        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)

        return line
