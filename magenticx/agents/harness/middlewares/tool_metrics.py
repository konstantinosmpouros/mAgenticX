"""Per-tool-call metrics: how long a tool ran, whether it failed, how much it returned.

Token usage says what the model cost; it says nothing about the tools the model
called — which ones run slowly, which ones fail, which ones flood the context
with output. This middleware times every tool call and stamps the result on the
ToolMessage (``response_metadata["mx_tool_metrics"]``), and the AG-UI normalizer
turns the stamp into a ``TOOL_USAGE`` event right after the call's result.

Why stamp the message instead of emitting an event: the same reason as
``UsageMetricsMiddleware`` — a deep agent streams only the ``messages`` and
``updates`` modes, so the settled ToolMessage is the one thing that reaches the
normalizer. Metrics only: neither arguments nor output content are recorded.

**Placement.** ``DeepAgent`` puts this middleware directly *outside*
``ToolErrorMiddleware`` (first in the list is outermost), so a tool that raised
reaches it already converted into a ``ToolMessage(status="error")`` and is
counted as an error, timed like any other call. Should a tool raise past it
(no error middleware inside), nothing is recorded and the exception propagates
unchanged — there is no message to stamp, and ``GraphBubbleUp`` (a HITL pause,
a parent command) is control flow that must reach the runner untouched.

A ``Command`` result (``task``, state-writing tools) is stamped on the
ToolMessage it carries for this call, with ``output_chars`` 0: its real output
is a state update, not text the model reads back.
"""
from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from core.logging import get_logger

logger = get_logger(__name__)

#: Key on ``ToolMessage.response_metadata`` the normalizer reads.
TOOL_METRICS_KEY = "mx_tool_metrics"

#: Longest tool name carried on the event.
MAX_TOOL_NAME = 200


def content_chars(content: Any) -> int:
    """Length of a tool result's content as text.

    A string is measured as is; a list of content blocks by its text parts
    (an image block is not text, so it does not count).
    """
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        total = 0
        for block in content:
            if isinstance(block, str):
                total += len(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                total += len(block["text"])
        return total
    return 0 if content is None else len(str(content))


def _result_message(request: ToolCallRequest, result: Any) -> tuple[ToolMessage | None, int]:
    """The ToolMessage this call produced and its output size, or ``(None, 0)``."""
    if isinstance(result, ToolMessage):
        return result, content_chars(result.content)
    if isinstance(result, Command) and isinstance(result.update, dict):
        call_id = (request.tool_call or {}).get("id")
        for message in result.update.get("messages") or []:
            if isinstance(message, ToolMessage) and message.tool_call_id == call_id:
                return message, 0
    return None, 0


class ToolMetricsMiddleware(AgentMiddleware):
    """Time each tool call and stamp duration, status and output size on its result."""

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        started = time.monotonic()
        result = handler(request)  # an exception propagates as is (see module docstring)
        self._stamp(request, result, started)
        return result

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        started = time.monotonic()
        result = await handler(request)
        self._stamp(request, result, started)
        return result

    @staticmethod
    def _stamp(request: ToolCallRequest, result: Any, started: float) -> None:
        """Attach the metrics. Never fails the call: a result without metrics is
        still a result, so a surprise in its shape is logged and skipped."""
        duration_ms = int((time.monotonic() - started) * 1000)
        try:
            message, output_chars = _result_message(request, result)
            if message is None:
                return
            name = (request.tool_call or {}).get("name") or message.name or "tool"
            metrics = {
                "tool_name": str(name)[:MAX_TOOL_NAME],
                "duration_ms": duration_ms,
                "status": "error" if message.status == "error" else "ok",
                "output_chars": output_chars,
            }
            message.response_metadata = {**(message.response_metadata or {}), TOOL_METRICS_KEY: metrics}
        except (AttributeError, TypeError, ValueError) as exc:
            logger.warning(
                "tool_metrics_skipped",
                "Could not attach tool metrics to a tool result",
                error_type=type(exc).__name__,
            )
