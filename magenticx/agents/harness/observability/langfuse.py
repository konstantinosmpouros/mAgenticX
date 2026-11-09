"""Agent traces to the self-hosted Langfuse — an opt-in, fail-open add-on.

Like the MCP gateway and the sandbox, Langfuse is a sibling project
(``../../langfuse``) that mAgenticX runs with or without:

- **Off** (the default): no ``LANGFUSE_BASE_URL`` or a missing key. No client
  is created, :func:`trace_run_config` hands every config back untouched, and
  nothing is sent anywhere.
- **On**: one process-wide client, started by the lifespan. Each run gets its
  own LangChain ``CallbackHandler``; spans leave in a background batch, so a
  run never waits on Langfuse, and a Langfuse that is down costs only those
  traces (the OpenTelemetry exporter drops them after its retries).

Every string leaves the process through :func:`mask` first — the patterns the
Langfuse contract makes mandatory (``../../langfuse/docs/app-integration.md``
§ 3), credentials inside URLs, and the field names the log redaction already
treats as secrets — so logs and traces redact the same things. The user is
sent as the keyed ``h:<16hex>`` pseudonym the logs use for IPs, never raw.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from langfuse import Langfuse
from langfuse.langchain import CallbackHandler
from pydantic import BaseModel

from core.logging import get_logger
from core.logging.redaction import hash_identifier, is_sensitive_key
from core.settings import settings

logger = get_logger(__name__)

# The contract's mandatory patterns, then mAgenticX's own. Order matters: the
# Langfuse key pattern runs before the generic ``sk-`` one.
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(?:sk|pk)-lf-[A-Za-z0-9-]{8,}"), "[REDACTED_LANGFUSE_KEY]"),
    (re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}"), "[REDACTED_API_KEY]"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "[REDACTED_AWS_KEY]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), "[REDACTED_JWT]"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*"), "Bearer [REDACTED]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[REDACTED_EMAIL]"),
    # user:password@ in a connection string or URL (postgresql://, redis://, https://).
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/:@]+:[^\s/@]+@"), r"\1[REDACTED]@"),
)
# Deeper than any real message or tool payload; a guard against cyclic or
# pathological structures, never hit in practice.
_MAX_DEPTH = 64

_client: Langfuse | None = None


def _mask_str(value: str) -> str:
    for pattern, replacement in _PATTERNS:
        value = pattern.sub(replacement, value)
    return value


def _mask_value(value: Any, *, key: str | None, depth: int) -> Any:
    """Mask one value of an input, output or metadata tree.

    Fail-closed on shapes it does not know: an arbitrary object is masked as
    its ``str()``, never passed through, so nothing reaches Langfuse unmasked.
    Only string values under a credential-like key are blanked — a number under
    ``max_tokens`` is not a secret.
    """
    if depth > _MAX_DEPTH:
        return "[TRUNCATED]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return "[REDACTED]" if key is not None and is_sensitive_key(key) else _mask_str(value)
    if isinstance(value, Mapping):
        return {str(k): _mask_value(v, key=str(k), depth=depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_mask_value(item, key=None, depth=depth + 1) for item in value]
    if isinstance(value, BaseModel):
        return _mask_value(value.model_dump(mode="json"), key=key, depth=depth + 1)
    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"
    return _mask_str(str(value))


def mask(*, data: Any, **_kwargs: Any) -> Any:
    """The SDK's ``mask`` hook: applied to every input, output and metadata."""
    return _mask_value(data, key=None, depth=0)


def init_langfuse() -> None:
    """Create the process-wide client when tracing is configured (lifespan startup).

    A client that cannot be created leaves tracing off and the service
    running — a trace is never a reason not to serve.
    """
    global _client
    cfg = settings.langfuse
    if not cfg.enabled:
        logger.info("langfuse_disabled", "Langfuse tracing is off (no LANGFUSE_BASE_URL or no readable keys)",
                    base_url_set=bool(cfg.base_url.strip()))
        return
    try:
        _client = Langfuse(
            public_key=cfg.public_key.get_secret_value(),
            secret_key=cfg.secret_key.get_secret_value(),
            base_url=cfg.base_url.strip(),
            timeout=cfg.timeout_seconds,
            release=settings.app.version,
            sample_rate=cfg.sample_rate,
            mask=mask,
        )
    except (ValueError, TypeError, RuntimeError, OSError):
        logger.warning("langfuse_init_failed", "Langfuse client could not be created; tracing stays off",
                       exc_info=True)
        _client = None
        return
    logger.info("langfuse_enabled", "Langfuse tracing is on", sample_rate=cfg.sample_rate)


def shutdown_langfuse() -> None:
    """Flush the spans still queued and stop the exporter (lifespan shutdown).

    Blocking (the exporter's own timeout bounds it) — the lifespan runs it in a
    thread so the event loop is never held.
    """
    global _client
    client, _client = _client, None
    if client is None:
        return
    try:
        client.shutdown()
    except (RuntimeError, OSError, ValueError):
        logger.warning("langfuse_shutdown_failed", "Langfuse flush on shutdown failed", exc_info=True)


def tracing_enabled() -> bool:
    """True while a client is live — the check every call site makes."""
    return _client is not None


def trace_run_config(
    config: Mapping[str, Any],
    *,
    kind: str,
    name: str,
    session_id: str | None = None,
    user_id: str | None = None,
    tags: Sequence[str] = (),
) -> Mapping[str, Any]:
    """``config`` plus a Langfuse handler and the trace's attributes.

    With tracing off this returns ``config`` itself, unchanged. With it on, a
    fresh ``CallbackHandler`` (one per run — it keeps per-run state) is
    appended to the callbacks, and the metadata names the trace (``name``),
    groups it (``session_id`` — the conversation, or the workflow run) and
    attributes it (``user_id``, sent as its pseudonym). ``kind`` (chat,
    subagent, workflow, compaction, title, suggestions) and ``tags`` become
    Langfuse tags for filtering.

    A callback *manager* already on the config is left alone, as in
    ``BaseAgent._config_with_callback``: that run is then simply not traced.
    """
    if _client is None:
        return config
    existing = config.get("callbacks")
    handler = CallbackHandler(public_key=settings.langfuse.public_key.get_secret_value())
    if existing is None:
        callbacks: list[Any] = [handler]
    elif isinstance(existing, (list, tuple)):
        callbacks = [*existing, handler]
    else:
        logger.warning("langfuse_handler_not_attached", "Run has a callback manager; not traced", kind=kind)
        return config
    metadata: dict[str, Any] = dict(config.get("metadata") or {})
    metadata["langfuse_trace_name"] = name
    metadata["langfuse_tags"] = sorted({"magenticx", kind, *(tag for tag in tags if tag)})
    if session_id:
        metadata["langfuse_session_id"] = str(session_id)
    if user_id:
        metadata["langfuse_user_id"] = hash_identifier(user_id)
    return {**config, "callbacks": callbacks, "metadata": metadata}
