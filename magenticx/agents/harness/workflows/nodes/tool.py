"""``tool`` — call one native tool or one MCP gateway tool with templated args.

The tool is referenced, never defined here: ``{"source": "mcp", "name":
"tavily-search"}`` resolves against the live gateway catalogue (the same one
the agent builder lists, loaded the same way a chat run loads it —
``optional_mcp_session`` + ``load_mcp_tools``), ``{"source": "native", "name":
…}`` against the native registry.

Only tools the owner can use without a conversation are reachable:

* MCP — the gateway catalogue, which is the same for every user;
* native — :data:`WORKFLOW_NATIVE_TOOLS`. Native tools are built per run for a
  user, and most need a conversation (files, charts, artifacts, ``ask_user``)
  or are approval-gated writes (``forget``, ``create_skill``); a workflow has
  neither a conversation nor a per-call approval gate yet, so those stay out
  rather than run ungated. The ``approval`` node is the gate to put in front of
  a side effect.

The call streams as an ordinary tool call (``TOOL_CALL_START`` / ``ARGS`` /
``RESULT`` / ``END``) inside the node's bracket. Output: ``{"result": …}`` —
parsed JSON when the tool returned JSON text, else the text.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Any, Literal

from langchain_mcp_adapters.tools import load_mcp_tools
from pydantic import BaseModel, ConfigDict, Field

from harness.agui.emitter import send
from harness.tools.registry import NATIVE_TOOLS, NativeToolContext, resolve_native_tool
from harness.workflows.errors import NodeExecutionError
from harness.workflows.nodes.base import (
    NodeConfig,
    NodeContext,
    NodeResult,
    ValidationContext,
    WorkflowNode,
)
from utils.mcp_tools import optional_mcp_session

#: Native tools a workflow may call (see the module docstring for why so few).
WORKFLOW_NATIVE_TOOLS = frozenset({"search_past_conversations"})
MAX_TIMEOUT_SECONDS = 300.0
MAX_RESULT_BYTES = 1024 * 1024


class ToolRef(BaseModel):
    """Which tool."""

    model_config = ConfigDict(extra="forbid")

    source: Literal["native", "mcp"]
    name: str = Field(pattern=r"^[A-Za-z0-9_.:/-]{1,128}$")


class ToolConfig(NodeConfig):
    """The tool and its arguments."""

    tool: ToolRef = Field(json_schema_extra={"x-widget": "tool"})
    args: dict[str, Any] = Field(
        default_factory=dict,
        description="Tool arguments; templates allowed",
        json_schema_extra={"x-widget": "tool_args"},
    )
    timeout_seconds: float = Field(default=60.0, gt=0, le=MAX_TIMEOUT_SECONDS)


def _jsonable(value: Any) -> Any:
    """A JSON-safe copy (the output is checkpointed and streamed)."""
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def normalize_result(result: Any) -> Any:
    """A tool's return value as data: JSON text parsed, MCP text blocks joined."""
    if isinstance(result, tuple) and len(result) == 2:
        result = result[0]  # (content, artifact)
    if isinstance(result, list) and result and all(
        isinstance(block, dict) and block.get("type") == "text" for block in result
    ):
        result = "\n".join(str(block.get("text", "")) for block in result)
    if isinstance(result, str):
        try:
            return json.loads(result)
        except ValueError:
            return result
    return _jsonable(result)


class ToolNode(WorkflowNode):
    """One tool call."""

    kind = "tool"
    label = "Tool"
    group = "tools"
    description = "Calls one MCP gateway tool or allowed native tool with the given arguments."
    Config = ToolConfig

    def validate_semantics(self, ctx: ValidationContext) -> list[tuple[str, str]]:
        ref = self.config.tool
        if ref.source == "native":
            if ref.name not in WORKFLOW_NATIVE_TOOLS:
                allowed = ", ".join(sorted(WORKFLOW_NATIVE_TOOLS))
                return [("tool.name", f"Native tool '{ref.name}' cannot be used in a workflow (allowed: {allowed}).")]
        elif ctx.known_mcp_tools is not None and ref.name not in ctx.known_mcp_tools:
            return [("tool.name", f"MCP tool '{ref.name}' is not in the gateway catalogue.")]
        return []

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        cfg: ToolConfig = ctx.config
        name = cfg.tool.name
        call_id = f"{ctx.run.run_id}:{ctx.execution_id}"
        send(ctx.writer, [ctx.emitter.tool_call_start(call_id, name), ctx.emitter.tool_call_args(call_id, name, cfg.args)])
        try:
            async with asyncio.timeout(cfg.timeout_seconds):
                if cfg.tool.source == "native":
                    raw = await self._call_native(name, cfg.args, ctx)
                else:
                    raw = await self._call_mcp(name, cfg.args)
            result = normalize_result(raw)
            if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES:
                raise NodeExecutionError("The tool result is larger than 1 MiB.", code="tool_too_large")
        except TimeoutError as exc:
            self._fail(call_id, ctx)
            raise NodeExecutionError("The tool call timed out.", code="tool_timeout") from exc
        except NodeExecutionError:
            self._fail(call_id, ctx)
            raise
        except Exception as exc:
            # Tool implementations raise anything; the run sees one safe reason.
            self._fail(call_id, ctx)
            raise NodeExecutionError(f"The tool call failed ({type(exc).__name__}).", code="tool_failed") from exc
        output = result if isinstance(result, (str, dict)) else json.dumps(result)
        send(ctx.writer, [ctx.emitter.tool_call_result(call_id, output), ctx.emitter.tool_call_end(call_id)])
        return NodeResult(output={"result": result})

    @staticmethod
    def _fail(call_id: str, ctx: NodeContext) -> None:
        send(ctx.writer, [ctx.emitter.tool_call_result(call_id, "The tool call failed.", error=True),
                          ctx.emitter.tool_call_end(call_id)])

    @staticmethod
    async def _call_native(name: str, args: dict[str, Any], ctx: NodeContext) -> Any:
        # Re-checked at run time: the spec was validated against this list, but
        # the list is the authority, not the stored spec.
        if name not in WORKFLOW_NATIVE_TOOLS or name not in NATIVE_TOOLS:
            raise NodeExecutionError(f"Native tool '{name}' is not available to workflows.", code="tool_unavailable")
        tool = resolve_native_tool(
            name,
            NativeToolContext(
                user_id=ctx.run.owner_user_id,
                agent_slug=f"workflow:{ctx.run.workflow_id}",
                conversation_id=None,
                use_memory=False,
                search_past_convs=True,
                run_id=ctx.run.run_id,
                thread_id=ctx.run.thread_id,
                interactive=False,
            ),
        )
        if tool is None:
            raise NodeExecutionError(f"Native tool '{name}' is not available to this run.", code="tool_unavailable")
        return await tool.ainvoke(args)

    @staticmethod
    async def _call_mcp(name: str, args: dict[str, Any]) -> Any:
        async with optional_mcp_session() as session:
            if session is None:
                raise NodeExecutionError("The MCP gateway is not available.", code="tool_unavailable")
            tools = await load_mcp_tools(session)
            tool = next((t for t in tools if getattr(t, "name", None) == name), None)
            if tool is None:
                raise NodeExecutionError(f"MCP tool '{name}' is not in the gateway catalogue.", code="tool_unavailable")
            return await tool.ainvoke(args)
