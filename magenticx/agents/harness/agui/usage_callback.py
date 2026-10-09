"""Token usage for LangGraph agents: a LangChain callback that turns every
chat-model call into a ``TOKEN_USAGE`` event.

Deep agents report usage through the AG-UI normalizer, which reads
``usage_metadata`` off the AIMessages their graph streams (and the model, time
and context that ``UsageMetricsMiddleware`` stamps on them). LangGraph agents
(HR, Retail, …) stream nothing of the kind: they run in ``custom`` mode, their
nodes write AG-UI events by hand, and their chains' AIMessages never reach the
normalizer. So their spend was invisible — the Usage tab would have shown zeros
next to Omni.

This handler closes the gap without touching any agent. Attached to the run's
config, it propagates to every chain a node invokes (LangChain carries the
config through context), times each chat-model call, reads the provider's
usage when the call ends, and queues one ``TOKEN_USAGE`` per call. The stream
loop drains the queue between chunks, so the events reach the bridge as any
other usage does — keyed by the callback's run id so the bridge's dedupe holds.

No context occupancy is reported: a LangGraph agent is a pipeline of separate
prompts (analysis, query generation, ranking, the answer), not one growing
conversation, so there is no single window to fill.
"""
from __future__ import annotations

import time
from typing import Any, Optional
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult

from core.logging import get_logger

logger = get_logger(__name__)


def _usage_from_token_usage(token_usage: dict[str, Any]) -> dict[str, Any]:
    """OpenAI's ``llm_output["token_usage"]`` in ``usage_metadata`` shape."""
    prompt = token_usage.get("prompt_tokens") or 0
    completion = token_usage.get("completion_tokens") or 0
    cached = (token_usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    reasoning = (token_usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
    return {
        "input_tokens": prompt,
        "output_tokens": completion,
        "total_tokens": token_usage.get("total_tokens") or prompt + completion,
        "input_token_details": {"cache_read": cached},
        "output_token_details": {"reasoning": reasoning},
    }


def usage_from_result(response: LLMResult) -> Optional[dict[str, Any]]:
    """The call's token usage: the AIMessage's ``usage_metadata`` when the
    provider set it (streamed calls included), else ``llm_output``."""
    for generations in response.generations:
        for generation in generations:
            usage = getattr(getattr(generation, "message", None), "usage_metadata", None)
            if isinstance(usage, dict) and usage:
                return dict(usage)
    token_usage = (response.llm_output or {}).get("token_usage")
    if isinstance(token_usage, dict) and token_usage:
        return _usage_from_token_usage(token_usage)
    return None


class UsageMetricsCallback(AsyncCallbackHandler):
    """Queues one ``(usage, call id, metrics)`` per settled chat-model call.

    One instance per agent run — never shared — so the queue only ever holds
    this run's calls. Async on purpose: an async handler is awaited in the
    calling task, so it never needs a thread and never reorders calls.
    """

    def __init__(self) -> None:
        self._started: dict[UUID, tuple[float, Optional[str]]] = {}
        self._pending: list[tuple[dict[str, Any], str, dict[str, Any]]] = []

    async def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: UUID,
        metadata: Optional[dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        params = kwargs.get("invocation_params") or {}
        model = (metadata or {}).get("ls_model_name") or params.get("model") or params.get("model_name")
        self._started[run_id] = (time.perf_counter(), str(model)[:200] if model else None)

    async def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        started_at, model = self._started.pop(run_id, (None, None))
        usage = usage_from_result(response)
        if usage is None:
            logger.debug("usage_callback_no_usage", "A model call reported no token usage")
            return
        metrics: dict[str, Any] = {"model": model}
        if started_at is not None:
            metrics["latency_ms"] = int((time.perf_counter() - started_at) * 1000)
        self._pending.append((usage, f"lg-{run_id}", metrics))

    async def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._started.pop(run_id, None)

    def drain(self) -> list[tuple[dict[str, Any], str, dict[str, Any]]]:
        """Hand over the calls settled since the last drain, oldest first."""
        pending, self._pending = self._pending, []
        return pending
