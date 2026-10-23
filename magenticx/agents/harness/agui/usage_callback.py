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

**Time to first token** is the first streamed chunk with output after
``on_chat_model_start``, per callback run id — present only for the calls a
node streams (its answer generation), as a non-streamed call has no first token.

**Tool calls** a node's chains make are reported the same way, as
``TOOL_USAGE`` (keyed ``lg-<run_id>``): duration, ok/error, output size — the
metrics a deep agent's ``ToolMetricsMiddleware`` stamps. They queue separately
(:meth:`UsageMetricsCallback.drain_tools`) so ``drain()`` keeps its shape.

The per-token and per-tool hooks are plain methods (with ``run_inline``):
LangChain then calls them inline on the sync and async paths alike, where an
async hook on a sync stream would cost a thread and an event loop per token.
"""
from __future__ import annotations

import time
from typing import Any, Optional
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.messages import ToolMessage
from langchain_core.outputs import LLMResult
from langgraph.errors import GraphBubbleUp
from langgraph.types import Command

from core.logging import get_logger
from harness.middlewares.first_token import is_first_token
from harness.middlewares.tool_metrics import MAX_TOOL_NAME, content_chars
from harness.middlewares.usage_metrics import TRUNCATION_FINISH_REASONS, finish_reason

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


def finish_reason_from_result(response: LLMResult) -> Optional[str]:
    """Why the provider ended the call: off the AIMessage, else the generation info."""
    for generations in response.generations:
        for generation in generations:
            reason = finish_reason(getattr(getattr(generation, "message", None), "response_metadata", None))
            if reason is None:
                reason = finish_reason(getattr(generation, "generation_info", None))
            if reason:
                return reason
    return None


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
    calling task, so it never needs a thread and never reorders calls. Inline
    for the same reason: its hooks are cheap bookkeeping, so they run before
    any other handler is gathered.
    """

    run_inline = True

    def __init__(self) -> None:
        self._started: dict[UUID, tuple[float, Optional[str]]] = {}
        self._first_token: dict[UUID, float] = {}
        self._pending: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
        self._tools_started: dict[UUID, tuple[float, str]] = {}
        self._pending_tools: list[dict[str, Any]] = []

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

    def on_llm_new_token(self, token: str, *, chunk: Any = None, run_id: UUID, **kwargs: Any) -> None:
        if run_id in self._started and run_id not in self._first_token and is_first_token(token, chunk):
            self._first_token[run_id] = time.perf_counter()

    async def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        started_at, model = self._started.pop(run_id, (None, None))
        first_token_at = self._first_token.pop(run_id, None)
        usage = usage_from_result(response)
        if usage is None:
            logger.debug("usage_callback_no_usage", "A model call reported no token usage")
            return
        metrics: dict[str, Any] = {"model": model}
        if started_at is not None:
            metrics["latency_ms"] = int((time.perf_counter() - started_at) * 1000)
            if first_token_at is not None:
                metrics["ttft_ms"] = max(int((first_token_at - started_at) * 1000), 0)
        reason = finish_reason_from_result(response)
        if reason:
            metrics["finish_reason"] = reason
            metrics["truncated"] = reason in TRUNCATION_FINISH_REASONS
            if metrics["truncated"]:
                logger.warning(
                    "model_call_truncated",
                    "Model stopped at its output-token ceiling; the reply is cut off",
                    model=model,
                    finish_reason=reason,
                    output_tokens=usage.get("output_tokens"),
                )
        self._pending.append((usage, f"lg-{run_id}", metrics))

    async def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._started.pop(run_id, None)
        self._first_token.pop(run_id, None)

    def drain(self) -> list[tuple[dict[str, Any], str, dict[str, Any]]]:
        """Hand over the calls settled since the last drain, oldest first."""
        pending, self._pending = self._pending, []
        return pending

    # ---------------------------------------------------------------- tools
    def on_tool_start(
        self,
        serialized: dict[str, Any] | None,
        input_str: str,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        name = kwargs.get("name") or (serialized or {}).get("name") or "tool"
        self._tools_started[run_id] = (time.perf_counter(), str(name)[:MAX_TOOL_NAME])

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        if isinstance(output, ToolMessage):
            status, chars = ("error" if output.status == "error" else "ok"), content_chars(output.content)
        elif isinstance(output, Command):
            status, chars = "ok", 0
        else:
            status, chars = "ok", content_chars(output)
        self._settle_tool(run_id, status, chars)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        if isinstance(error, GraphBubbleUp):
            # A HITL pause or parent command, not a failure: the call reruns on resume.
            self._tools_started.pop(run_id, None)
            return
        self._settle_tool(run_id, "error", 0)

    def _settle_tool(self, run_id: UUID, status: str, output_chars: int) -> None:
        started = self._tools_started.pop(run_id, None)
        if started is None:
            return
        started_at, name = started
        self._pending_tools.append({
            "tool_call_id": f"lg-{run_id}",
            "tool_name": name,
            "duration_ms": int((time.perf_counter() - started_at) * 1000),
            "status": status,
            "output_chars": output_chars,
        })

    def drain_tools(self) -> list[dict[str, Any]]:
        """Hand over the tool calls settled since the last drain, oldest first,
        as ``AGUIEmitter.tool_usage`` keyword arguments."""
        pending, self._pending_tools = self._pending_tools, []
        return pending
