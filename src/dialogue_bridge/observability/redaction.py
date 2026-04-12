from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any


_SENSITIVE_FIELD_TOKENS = (
    "password",
    "token",
    "authorization",
    "cookie",
    "secret",
    "csrf",
    "datab64",
    "data_b64",
)
_DROP_FIELD_NAMES = {"username", "title", "file_name", "filename", "message_content", "content", "history"}
_HASHED_CONTEXT_FIELDS = {"client_ip", "session_id"}
_HASHED_FIELD_NAMES = {"client_ip", "session_id"}
_MAX_STRING_LENGTH = 256
_REDACTION_SECRET = (
    os.getenv("LOG_REDACTION_SECRET")
    or os.getenv("SESSION_TOKEN_SECRET")
    or "dialogue-bridge-log-redaction"
).encode("utf-8")


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(token in lowered for token in _SENSITIVE_FIELD_TOKENS)


def _should_drop_key(key: str) -> bool:
    lowered = key.lower()
    return lowered in _DROP_FIELD_NAMES


def _truncate_string(value: str) -> str:
    if len(value) > _MAX_STRING_LENGTH:
        return value[:_MAX_STRING_LENGTH] + "...<truncated>"
    return value


def _stable_hash(value: Any) -> str:
    digest = hmac.new(_REDACTION_SECRET, str(value).encode("utf-8"), hashlib.sha256).hexdigest()
    return f"h:{digest[:16]}"


def sanitize_context_value(key: str, value: Any) -> Any:
    if value is None:
        return None
    if key in _HASHED_CONTEXT_FIELDS and value not in {"-", "no-session"}:
        return _stable_hash(value)
    return sanitize_for_logging(value, key=key)


def sanitize_for_logging(value: Any, *, key: str | None = None) -> Any:
    if key and _should_drop_key(key):
        return "[OMITTED]"

    if key and key.lower() in _HASHED_FIELD_NAMES and value not in (None, "", "-", "no-session"):
        return _stable_hash(value)

    if key and _is_sensitive_key(key):
        return "[REDACTED]"

    if isinstance(value, dict):
        return {
            str(k): sanitized
            for k, v in value.items()
            if (sanitized := sanitize_for_logging(v, key=str(k))) not in (None, "", {}, [], "[OMITTED]")
        }

    if isinstance(value, (list, tuple, set)):
        return [
            sanitized
            for item in value
            if (sanitized := sanitize_for_logging(item)) not in (None, "", {}, [], "[OMITTED]")
        ]

    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"

    if isinstance(value, str):
        return _truncate_string(value)

    if value is None or isinstance(value, (bool, int, float)):
        return value

    return _truncate_string(str(value))
