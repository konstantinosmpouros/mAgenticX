"""Wait out a provider rate limit (HTTP 429) instead of failing the whole run.

The OpenAI client retries a 429 a couple of times on its own, with a backoff of
a second or two. A per-minute token quota — the usual cause on a long deep-agent
run with parallel sub-agents — needs longer than that to clear, so without this
the run dies with a RateLimitError a few seconds in. This middleware waits
``delay_seconds`` (or the provider's ``Retry-After``, when larger) and re-issues
the model call, up to ``max_attempts`` attempts in all (``RateLimitRetrySettings``).

Re-issuing is safe: a 429 is refused before any token streams, so the retried
call never duplicates output. ``insufficient_quota`` is a 429 too, but it means
the account is out of credit — waiting cannot fix that, so it is raised at once.

Only rate limits are retried. Everything else — including LangGraph's control
flow (``GraphBubbleUp``) — passes straight through.
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware

from core.logging import get_logger
from core.settings import settings

logger = get_logger(__name__)

# A 429 whose cause no wait can clear (the account is out of credit).
_NON_RETRYABLE_CODES = {"insufficient_quota"}


def is_rate_limit_error(exc: BaseException) -> bool:
    """True for a retryable upstream 429, detected without importing a provider SDK:
    OpenAI's ``RateLimitError`` by name, or a ``status_code`` of 429."""
    if getattr(exc, "code", None) in _NON_RETRYABLE_CODES:
        return False
    if type(exc).__name__ == "RateLimitError":
        return True
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    return status == 429


def retry_after_seconds(exc: BaseException) -> float | None:
    """The provider's ``Retry-After`` in seconds, when it sent a numeric one."""
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if not headers:
        return None
    value = headers.get("retry-after") or headers.get("Retry-After")
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


class RetryOnRateLimitMiddleware(AgentMiddleware):
    """Retry a model call that hit a rate limit, waiting between attempts.

    Guaranteed on every deep agent and sub-agent by ``build_deep_agent``. While it
    waits the run emits nothing, but the bridge's stream keeps heartbeating, so
    the UI connection stays open.
    """

    def __init__(
        self,
        *,
        max_attempts: int | None = None,
        delay_seconds: float | None = None,
        max_delay_seconds: float | None = None,
    ) -> None:
        super().__init__()
        cfg = settings.rate_limit_retry
        self.max_attempts = max_attempts if max_attempts is not None else cfg.max_attempts
        self.delay_seconds = delay_seconds if delay_seconds is not None else cfg.delay_seconds
        self.max_delay_seconds = max_delay_seconds if max_delay_seconds is not None else cfg.max_delay_seconds

    def delay_for(self, exc: BaseException) -> float:
        """At least the configured delay; a larger ``Retry-After`` wins, capped."""
        retry_after = retry_after_seconds(exc)
        delay = max(self.delay_seconds, retry_after) if retry_after is not None else self.delay_seconds
        return min(delay, self.max_delay_seconds)

    def _should_retry(self, exc: BaseException, attempt: int) -> bool:
        if not is_rate_limit_error(exc) or attempt >= self.max_attempts:
            return False
        logger.warning(
            "model_call_rate_limited",
            "Model call hit a rate limit; waiting before retrying",
            attempt=attempt,
            max_attempts=self.max_attempts,
            delay_seconds=self.delay_for(exc),
            exception_type=type(exc).__name__,
        )
        return True

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        attempt = 1
        while True:
            try:
                return handler(request)
            except Exception as exc:
                if not self._should_retry(exc, attempt):
                    raise
                time.sleep(self.delay_for(exc))
                attempt += 1

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        attempt = 1
        while True:
            try:
                return await handler(request)
            except Exception as exc:
                if not self._should_retry(exc, attempt):
                    raise
                await asyncio.sleep(self.delay_for(exc))
                attempt += 1
