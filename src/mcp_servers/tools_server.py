"""MCP server that exposes the LangChain tools copied into this package."""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Mapping

import anyio
from langchain_core.tools import BaseTool
from mcp.server.fastmcp import FastMCP
import mcp.types as types

from .langchain_tools import (
    articles_tools,
    computer_vision_tools,
    financial_tools,
    search_tools,
)


LOGGER = logging.getLogger("magenticx.mcp.tools")


@dataclass(frozen=True)
class ToolBinding:
    """Captures the metadata required to expose a LangChain tool via MCP."""

    tool: BaseTool
    input_schema: Dict[str, Any]
    description: str

    async def invoke(self, arguments: Mapping[str, Any] | None) -> Any:
        """Execute the underlying LangChain tool inside a worker thread."""

        def _call():
            payload = arguments or {}
            return self.tool.invoke(payload)

        return await anyio.to_thread.run_sync(_call)


def _resolve_schema(tool: BaseTool) -> Dict[str, Any]:
    schema_model = getattr(tool, "args_schema", None)
    if schema_model is None:
        return {"type": "object", "properties": {}}

    exporter = getattr(schema_model, "model_json_schema", None) or getattr(schema_model, "schema", None)
    if exporter is None:
        return {"type": "object", "properties": {}}

    schema = exporter()
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    return schema


def _describe(tool: BaseTool) -> str:
    raw = getattr(tool, "description", None) or ""
    if raw.strip():
        return raw.strip()
    func = getattr(tool, "func", None)
    doc = getattr(func, "__doc__", None)
    if isinstance(doc, str) and doc.strip():
        return doc.strip()
    return f"{tool.name} tool"


def _iter_all_tools() -> Iterable[BaseTool]:
    yield from financial_tools
    yield from search_tools
    yield from articles_tools
    yield from computer_vision_tools


def _collect_tool_bindings() -> Dict[str, ToolBinding]:
    registry: Dict[str, ToolBinding] = {}
    for tool in _iter_all_tools():
        schema = _resolve_schema(tool)
        description = _describe(tool)
        registry[tool.name] = ToolBinding(tool=tool, input_schema=schema, description=description)
    return dict(sorted(registry.items()))


TOOL_BINDINGS = _collect_tool_bindings()

server = FastMCP(
    name="magenticx-langchain-tools",
    instructions="Expose the copied LangChain tools via the Model Context Protocol.",
    host="0.0.0.0",
    port=8005,
    streamable_http_path="/mcp",
)
core_server = server._mcp_server


@core_server.list_tools()
async def handle_list_tools() -> types.ListToolsResult:
    tools = [
        types.Tool(
            name=name,
            description=binding.description,
            inputSchema=binding.input_schema,
        )
        for name, binding in TOOL_BINDINGS.items()
    ]
    return types.ListToolsResult(tools=tools)


def _format_result(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, bytes):
        return result.decode("utf-8", errors="replace")
    if isinstance(result, (dict, list)):
        try:
            return json.dumps(result, ensure_ascii=False, indent=2)
        except TypeError:
            return str(result)
    return str(result)


@core_server.call_tool()
async def handle_call_tool(tool_name: str, arguments: Mapping[str, Any] | None) -> types.CallToolResult:
    binding = TOOL_BINDINGS.get(tool_name)
    if binding is None:
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"Unknown tool '{tool_name}'.")],
            isError=True,
        )

    try:
        result = await binding.invoke(arguments)
        text = _format_result(result)
        return types.CallToolResult(content=[types.TextContent(type="text", text=text)], isError=False)
    except Exception as exc:
        LOGGER.exception("Tool %s failed", tool_name)
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"Tool '{tool_name}' failed: {exc}")],
            isError=True,
        )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Standalone MCP server for the copied LangChain tools.")
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging verbosity (DEBUG, INFO, WARNING, ERROR).",
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse", "streamable-http"],
        default="streamable-http",
        help="Transport the FastMCP server should use.",
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Host interface for SSE/HTTP transports.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8005,
        help="Port for SSE/HTTP transports.",
    )
    parser.add_argument(
        "--mount-path",
        default="/",
        help="Mount path for SSE transport (ignored otherwise).",
    )
    parser.add_argument(
        "--http-path",
        default="/mcp",
        help="Base path for streamable HTTP transport.",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))

    # Update FastMCP runtime settings prior to launch
    server.settings.host = args.host
    server.settings.port = args.port
    server.settings.mount_path = args.mount_path
    server.settings.streamable_http_path = args.http_path

    try:
        server.run(transport=args.transport, mount_path=args.mount_path)
    except KeyboardInterrupt:
        LOGGER.info("Shutting down MCP tools server.")


if __name__ == "__main__":
    main()
