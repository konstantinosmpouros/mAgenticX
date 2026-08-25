from __future__ import annotations

import hashlib
import hmac
import re
import uuid
from typing import Any

from core.settings import settings

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
_DROP_FIELD_NAMES = {
    "username",
    "title",
    "file_name",
    "filename",
    "message_content",
    "content",
    "history",
    "messages",
    "prompt",
    "completion",
    "query",
    "answer",
    "text",
    "input",
    "output",
    "delta",
    "chunk",
    "sql",
    "page_content",
    "documents",
}
_HASHED_CONTEXT_FIELDS = {"client_ip"}
# Values that represent "no identifier" — logged as-is, never hashed.
_BLANK_IDENTIFIERS = (None, "", "-", "no-session", "anonymous")
_MAX_STRING_LENGTH = 256
_HASH_RE = re.compile(r"h:[0-9a-f]{16}")


def _should_hash_field(key: str) -> bool:
    k = key.lower()
    # Only client_ip is hashed (it's a real IP). user_id / session_id are logged
    # RAW so the logs correlate directly with the database.
    return k == "client_ip"


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


def _is_hashed(value: Any) -> bool:
    return isinstance(value, str) and bool(_HASH_RE.fullmatch(value))


def _stable_hash(value: Any) -> str:
    key = settings.logging.redaction_secret.get_secret_value().encode("utf-8")
    digest = hmac.new(key, str(value).encode("utf-8"), hashlib.sha256).hexdigest()
    return f"h:{digest[:16]}"


def _hash_identifier(value: Any) -> str:
    # Idempotent: a value already in canonical h:<16hex> form (e.g. a session
    # hash forwarded from a peer service) is passed through, so the same id
    # yields the same token across services. The match is strict — an
    # "h:"-prefixed value with any other char is re-hashed, so a forged header
    # cannot ride the passthrough to inject into the logs.
    return value if _is_hashed(value) else _stable_hash(value)


def sanitize_context_value(key: str, value: Any) -> Any:
    if value is None:
        return None
    if key in _HASHED_CONTEXT_FIELDS and value not in _BLANK_IDENTIFIERS:
        return _hash_identifier(value)
    return sanitize_for_logging(value, key=key)


def sanitize_for_logging(value: Any, *, key: str | None = None) -> Any:
    if key and _should_drop_key(key):
        return "[OMITTED]"

    if key and _should_hash_field(key) and value not in _BLANK_IDENTIFIERS:
        return _hash_identifier(value)

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


_REQUEST_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,128}")


def sanitize_request_id(raw: str | None) -> str:
    # The inbound X-Request-ID is attacker-controllable; an unbounded value with
    # newlines or the "|" console delimiter would be a log-injection vector. Reject
    # anything that isn't a bounded id-safe token and mint a fresh server-side id.
    # Correlation only — never an auth/authz input.
    if raw:
        candidate = raw.strip()
        if _REQUEST_ID_RE.fullmatch(candidate):
            return candidate
    return str(uuid.uuid4())
