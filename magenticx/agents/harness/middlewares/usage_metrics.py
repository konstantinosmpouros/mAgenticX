"""Per-model-call metrics: which model ran, how long it took, how full its context was.

Every deep agent and sub-agent already reports token usage — the provider puts
``usage_metadata`` on each AIMessage and the AG-UI normalizer turns it into a
``TOKEN_USAGE`` event. What it could not say is *which* model produced those
tokens, how long the call took, and how close the conversation is to that
model's context window. This middleware measures exactly that around each model
call and stamps it on the reply (``response_metadata["mx_usage_metrics"]``), so
the same ``TOKEN_USAGE`` event carries it to the bridge and the UI.

Why stamp the message instead of emitting an event: deep agents stream only the
``messages`` and ``updates`` modes, so anything a middleware writes to the custom
channel goes nowhere — every deep-agent event is synthesised by the normalizer
from the settled messages. The stamp rides the message into the ``updates``
payload, where the normalizer already reads ``usage_metadata``.

**Context occupancy** is the provider-reported ``input_tokens`` of the call — the
whole prompt as the model saw it (system prompt, tools, history) — over the
model's ``max_input_tokens``. That is the same window the summarizer measures
against, so the gauge and the compaction trigger can never disagree.
"""
from __future__ import annotations

import re
import time
from functools import lru_cache
from typing import Any, Awaitable, Callable, Optional

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import AIMessage

from core.logging import get_logger

try:
    # Private, but it is the very table ``model.profile`` is filled from; used
    # only for dated names that the table lists under their base name.
    from langchain_openai.chat_models.base import _get_default_model_profile as _openai_profile
except ImportError:  # without langchain-openai there is simply no fallback
    _openai_profile = None

logger = get_logger(__name__)

#: Key on ``AIMessage.response_metadata`` the normalizer reads.
METRICS_KEY = "mx_usage_metrics"

_DATED_SUFFIX = re.compile(r"-\d{4}-\d{2}-\d{2}$")


def model_name(model: Any) -> Optional[str]:
    """The model's name as the provider knows it (``gpt-5``, ``gpt-4o-2024-08-06``)."""
    for attr in ("model_name", "model"):
        value = getattr(model, attr, None)
        if isinstance(value, str) and value:
            return value
    return None


@lru_cache(maxsize=64)
def _dated_base_window(name: str) -> Optional[int]:
    """Window of a dated snapshot, read from its base model's profile.

    ``gpt-5-2025-08-07`` has no profile entry of its own while ``gpt-5`` does,
    and a snapshot shares its base model's window. Deriving it keeps this free
    of a hand-maintained table that would drift from the provider's.
    """
    base = _DATED_SUFFIX.sub("", name)
    if base == name or _openai_profile is None:
        return None
    window = (_openai_profile(base) or {}).get("max_input_tokens")
    return window if isinstance(window, int) else None


def context_window(model: Any) -> Optional[int]:
    """The most input tokens ``model`` accepts, or ``None`` when unknown."""
    profile = getattr(model, "profile", None)
    if isinstance(profile, dict) and isinstance(profile.get("max_input_tokens"), int):
        return profile["max_input_tokens"]
    name = model_name(model)
    return _dated_base_window(name) if name else None


def _ai_messages(response: Any) -> list[AIMessage]:
    """The AIMessage(s) a model call produced, whatever wrapper it came in."""
    if isinstance(response, AIMessage):
        return [response]
    inner = getattr(response, "model_response", None)  # ExtendedModelResponse
    if inner is not None:
        response = inner
    return [m for m in getattr(response, "result", None) or [] if isinstance(m, AIMessage)]


class UsageMetricsMiddleware(AgentMiddleware):
    """Measure each model call and stamp the result on the reply.

    ``compaction_fraction`` is where this agent's summarizer compacts the
    conversation (a fraction of the window) — passed only when the stack really
    has our summarizer, so the UI's "compacts at" marker is never invented.
    """

    def __init__(self, *, compaction_fraction: Optional[float] = None) -> None:
        super().__init__()
        self.compaction_fraction = compaction_fraction

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        started = time.monotonic()
        response = handler(request)
        self._stamp(request, response, started)
        return response

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        started = time.monotonic()
        response = await handler(request)
        self._stamp(request, response, started)
        return response

    def _stamp(self, request: Any, response: Any, started: float) -> None:
        """Attach the metrics. Never fails the call: a reply without metrics is
        still a reply, so a surprise in the response shape is logged and skipped."""
        latency_ms = int((time.monotonic() - started) * 1000)
        try:
            model = getattr(request, "model", None)
            window = context_window(model)
            name = model_name(model)
            for message in _ai_messages(response):
                usage = message.usage_metadata or {}
                prompt = usage.get("input_tokens")
                metrics: dict[str, Any] = {"model": name, "latency_ms": latency_ms, "context_window": window}
                if isinstance(prompt, int):
                    metrics["context_tokens"] = prompt
                    if window:
                        metrics["context_percent"] = round(100 * prompt / window, 1)
                if window and self.compaction_fraction:
                    metrics["compaction_percent"] = round(100 * self.compaction_fraction, 1)
                message.response_metadata = {**(message.response_metadata or {}), METRICS_KEY: metrics}
        except (AttributeError, TypeError, ValueError) as exc:
            logger.warning(
                "usage_metrics_skipped",
                "Could not attach usage metrics to a model reply",
                error_type=type(exc).__name__,
            )
