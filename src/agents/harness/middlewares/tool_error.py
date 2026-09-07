from typing import Any, Awaitable, Callable

from langchain.agents.middleware.types import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphBubbleUp
from langgraph.types import Command

from core.logging import get_logger

logger = get_logger(__name__)


class ToolErrorMiddleware(AgentMiddleware):
    """Catch any exception raised by a tool call and return it as a
    ``ToolMessage(status="error")`` instead of letting it abort the whole run.

    Without this, a single failing tool (e.g. an MCP server returning HTTP 400)
    propagates out of ``agent.astream()`` and the entire inference is marked
    failed. Converting the exception into an error tool result lets the model
    see what went wrong and recover (retry, route around it, or tell the user),
    and surfaces as a normal ``TOOL_CALL_RESULT`` event the UI renders as a
    failed tool step. Applied to the main agent and every sub-agent via the
    base ``DeepAgent`` wiring.

    ``GraphBubbleUp`` is deliberately NOT caught. LangGraph raises it as
    *control flow*, not failure — ``GraphInterrupt`` (a HITL pause) and
    ``ParentCommand`` both derive from it, and both must reach the graph runner
    to do their job. Swallowing it here turned a sub-agent's approval request
    into a fake "tool failed" result: the ``task`` tool that spawned the
    sub-agent reported an error, the run limped on, and the approval the user
    was looking at was already superseded — so approving it returned 409 (stale
    interrupt) and the run died with no message.
    """

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        try:
            return handler(request)
        except GraphBubbleUp:
            # Control flow (interrupt / parent command) — must reach the runner.
            raise
        except Exception as exc:  # noqa: BLE001 — deliberate: never abort the run on a tool error
            return self._error_message(request, exc)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        try:
            return await handler(request)
        except GraphBubbleUp:
            # Control flow (interrupt / parent command) — must reach the runner.
            raise
        except Exception as exc:  # noqa: BLE001 — deliberate: never abort the run on a tool error
            return self._error_message(request, exc)

    @staticmethod
    def _error_message(request: ToolCallRequest, exc: Exception) -> ToolMessage:
        tool_call: dict[str, Any] = request.tool_call
        name = tool_call.get("name") or "tool"
        logger.warning(
            "tool_call_error",
            "Tool call failed; returning an error result so the run continues",
            tool=name,
            exception_type=type(exc).__name__,
        )
        return ToolMessage(
            tool_call_id=tool_call["id"],
            name=name,
            content=f"Tool '{name}' failed: {type(exc).__name__}: {exc}",
            status="error",
        )
