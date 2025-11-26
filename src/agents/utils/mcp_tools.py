import os
from typing import Dict, List, Sequence

import mcp
from mcp import types
from mcp.client.sse import sse_client

from schemas import ToolManifest


class MCPToolsClientError(RuntimeError):
    """Raised when the MCP tools endpoint cannot be queried."""


_MCP_TOOL_CACHE: Dict[str, types.Tool] = {}
_MCP_TOOL_MANIFEST_CACHE: Dict[str, ToolManifest] = {}


def _normalise_tool_name(tool: types.Tool) -> str:
    """Return a stable, stringified tool name as delivered by the MCP gateway."""
    value = getattr(tool, "name", "")
    if isinstance(value, str):
        return value
    try:
        return str(value)
    except Exception:
        return ""


def _build_manifest(tool: types.Tool) -> ToolManifest:
    """Create the UI-friendly manifest while preserving server/tool split."""
    annotations_obj = getattr(tool, "annotations", None)
    annotations = annotations_obj.model_dump() if annotations_obj else {}

    schema = tool.inputSchema if isinstance(tool.inputSchema, dict) else {}
    schema_properties = schema.get("properties")
    annotations_properties = annotations.get("properties") if isinstance(annotations, dict) else None
    if schema_properties and isinstance(schema_properties, dict) and schema_properties:
        parameter_count = len(schema_properties)
    elif annotations_properties and isinstance(annotations_properties, dict):
        parameter_count = len(annotations_properties)
    else:
        parameter_count = 0

    description = (tool.description or annotations.get("title") or "").strip()

    qualified_name = _normalise_tool_name(tool)
    if isinstance(qualified_name, str) and "_" in qualified_name:
        server_id, tool_name = qualified_name.split("_", 1)
    else:
        server_id = ""
        tool_name = qualified_name

    return ToolManifest(
        server_id=server_id,
        tool_name=tool_name,
        description=description,
        parameter_count=parameter_count,
    )


def _prime_mcp_tool_cache(tools: Sequence[types.Tool]) -> None:
    """Populate both the raw tool cache and the UI manifest cache."""
    global _MCP_TOOL_CACHE, _MCP_TOOL_MANIFEST_CACHE

    entries: list[tuple[str, types.Tool, ToolManifest]] = []
    seen: set[str] = set()
    for tool in tools:
        key = _normalise_tool_name(tool)
        if not key or key in seen:
            continue
        manifest = _build_manifest(tool)
        entries.append((key, tool, manifest))
        seen.add(key)

    # Sort by tool display name to keep responses stable.
    entries.sort(key=lambda item: item[2].tool_name.lower())

    _MCP_TOOL_CACHE = {key: tool for key, tool, _ in entries}
    _MCP_TOOL_MANIFEST_CACHE = {key: manifest for key, _, manifest in entries}


def get_cached_mcp_tools() -> Dict[str, types.Tool]:
    """Return the cached raw MCP tools keyed by their qualified name."""
    return dict(_MCP_TOOL_CACHE)


def get_cached_tool_manifests_map() -> Dict[str, ToolManifest]:
    """Return the cached ToolManifest objects keyed by their qualified name."""
    return dict(_MCP_TOOL_MANIFEST_CACHE)


def get_cached_tool_manifests() -> List[ToolManifest]:
    """Return cached ToolManifest instances in deterministic order."""
    return list(_MCP_TOOL_MANIFEST_CACHE.values())


async def _fetch_tools_from_gateway() -> List[types.Tool]:
    """Call the MCP gateway and return the raw tools list."""
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


async def list_mcp_tools(*, force_refresh: bool = False) -> List[types.Tool]:
    """Return the tools exposed by the MCP server, preferring the cache."""
    if _MCP_TOOL_CACHE and not force_refresh:
        return list(_MCP_TOOL_CACHE.values())

    tools = await _fetch_tools_from_gateway()
    _prime_mcp_tool_cache(tools)

    return list(_MCP_TOOL_CACHE.values())
