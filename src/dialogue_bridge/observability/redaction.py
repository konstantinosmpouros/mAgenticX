from __future__ import annotations

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
    "session",
)


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(token in lowered for token in _SENSITIVE_FIELD_TOKENS)


def sanitize_for_logging(value: Any, *, key: str | None = None) -> Any:
    if key and _is_sensitive_key(key):
        return "[REDACTED]"

    if isinstance(value, dict):
        return {str(k): sanitize_for_logging(v, key=str(k)) for k, v in value.items()}

    if isinstance(value, (list, tuple, set)):
        return [sanitize_for_logging(item) for item in value]

    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"

    if isinstance(value, str):
        if len(value) > 1000:
            return value[:1000] + "...<truncated>"
        return value

    if value is None or isinstance(value, (bool, int, float)):
        return value

    return str(value)
