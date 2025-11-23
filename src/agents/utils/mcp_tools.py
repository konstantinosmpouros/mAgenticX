import os
from typing import List

import mcp
from mcp import types
from mcp.client.sse import sse_client



class MCPToolsClientError(RuntimeError):
    """Raised when the MCP tools endpoint cannot be queried."""


async def list_mcp_tools() -> List[types.Tool]:
    """Return the tools exposed by the MCP server via the SSE transport."""

    endpoint = os.getenv("MCP_TOOLS_HTTP_URL", "http://mcp_gateway:8080/sse")
    if not endpoint:
        raise MCPToolsClientError("MCP tools endpoint is not configured.")

    try:
        async with sse_client(url=endpoint) as (read_stream, write_stream):
            async with mcp.ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.list_tools()
                return list(result.tools)
    except Exception as exc:  # pragma: no cover - defensive guardrail
        raise MCPToolsClientError(f"Failed to list tools from MCP server: {exc}") from exc
