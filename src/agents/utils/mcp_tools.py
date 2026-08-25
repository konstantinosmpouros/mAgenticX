from contextlib import asynccontextmanager
from typing import Dict, List, Sequence

import mcp
from mcp import types
from mcp.client.sse import sse_client

from core.settings import settings
from core.logging import get_logger
from schemas import ToolManifest

logger = get_logger(__name__)

class MCPToolsClientError(RuntimeError):
    """Raised when the MCP tools endpoint cannot be queried."""


_MCP_TOOL_MANIFEST_CACHE: Dict[str, ToolManifest] = {}
_TOOL_SERVER_OVERRIDES: dict[str, str] = {
    # Tavily MCP Server tools
    "tavily-crawl": "tavily",
    "tavily-extract": "tavily",
    "tavily-map": "tavily",
    "tavily-search": "tavily",
    # Arxiv MCP Server tools
    "download_paper": "arxiv",
    "search_papers": "arxiv",
    "read_paper": "arxiv",
    "list_papers": "arxiv",
}


def _extract_tool_identity(tool: types.Tool) -> tuple[str, str, str]:
    """
    Return (server_id, tool_name, qualified_name) extracted from the MCP tool.
    Falls back gracefully to empty strings on unexpected shapes.
    Tool names remain exactly as provided; only server_id is inferred.
    """
    tool_name = getattr(tool, "name", "") or ""
    if not isinstance(tool_name, str):
        try:
            tool_name = str(tool_name)
        except Exception:
            tool_name = ""
    
    # Always preserve the tool name as-is.
    server_id = _map_server_id("", tool_name)
    
    return str(server_id), str(tool_name)


def _map_server_id(server_id: str, tool_name: str) -> str:
    """
    Enforce server_id mappings when the gateway does not prefix tool names.
    Tool names remain unchanged; only the server_id is inferred.
    """
    if server_id:
        return server_id

    normalized = (tool_name or "").lower()
    if normalized in _TOOL_SERVER_OVERRIDES:
        return _TOOL_SERVER_OVERRIDES[normalized]

    return server_id


def build_cache_key_from_tool_name(tool_name: str) -> str:
    """Public helper to build a cache key from a bare tool name string."""
    raw_value = tool_name or ""
    server_id = _map_server_id("", raw_value)
    return _make_cache_key(server_id, raw_value)


def _make_cache_key(server_id: str, tool_name: str) -> str:
    """Return the canonical cache key using server_id/tool_name semantics."""
    server = (server_id or "").strip()
    name = (tool_name or "").strip()
    if server:
        return f"{server}/{name}"
    return name


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

    server_id, tool_name = _extract_tool_identity(tool)

    return ToolManifest(
        server_id=server_id,
        tool_name=tool_name,
        description=description,
        parameter_count=parameter_count,
    )


def _prime_manifest_cache(tools: Sequence[types.Tool]) -> None:
    """Populate the UI manifest cache keyed by server_id/tool_name."""
    global _MCP_TOOL_MANIFEST_CACHE

    entries: list[tuple[str, ToolManifest]] = []
    seen_keys: set[str] = set()

    for tool in tools:
        server_id, tool_name = _extract_tool_identity(tool)
        cache_key = _make_cache_key(server_id, tool_name)
        if not cache_key or cache_key in seen_keys:
            continue
        manifest = _build_manifest(tool)
        entries.append((cache_key, manifest))
        seen_keys.add(cache_key)

    entries.sort(key=lambda item: item[0].lower())
    _MCP_TOOL_MANIFEST_CACHE = {key: manifest for key, manifest in entries}


def get_cached_tool_manifests_map() -> Dict[str, ToolManifest]:
    """Return the cached ToolManifest objects keyed by server_id/tool_name."""
    return dict(_MCP_TOOL_MANIFEST_CACHE)


def get_cached_tool_manifests() -> List[ToolManifest]:
    """Return cached ToolManifest instances in deterministic order."""
    return list(_MCP_TOOL_MANIFEST_CACHE.values())


def build_tool_cache_key(server_id: str, tool_name: str) -> str:
    """Public helper to build a cache key from server/tool identifiers."""
    return _make_cache_key(server_id, tool_name)


def get_tool_cache_key(tool: types.Tool) -> str:
    """Public helper to build a cache key directly from an MCP tool object."""
    server_id, tool_name = _extract_tool_identity(tool)
    return _make_cache_key(server_id, tool_name)


async def _fetch_tools_from_gateway() -> List[types.Tool]:
    """Call the MCP gateway and return the raw tools list (for manifest building)."""
    endpoint = settings.mcp.mcp_gateway_url
    if not endpoint:
        raise MCPToolsClientError("MCP tools endpoint is not configured.")

    try:
        logger.info("mcp_tools_fetch_started", "MCP tools fetch started", upstream_service="mcp_gateway", endpoint=endpoint)
        async with sse_client(url=endpoint) as (read_stream, write_stream):
            async with mcp.ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.list_tools()
                tools = list(result.tools)
                logger.info("mcp_tools_fetch_completed", "MCP tools fetch completed", upstream_service="mcp_gateway", tool_count=len(tools))
                return tools
    except Exception as exc:  # pragma: no cover - defensive guardrail
        logger.warning(
            "mcp_tools_fetch_failed",
            "Failed to fetch tools from MCP gateway",
            exc_info=True,
            upstream_service="mcp_gateway",
            failure_reason="gateway_error",
        )
        raise MCPToolsClientError("Failed to list tools from MCP server.") from exc


async def list_mcp_tools(*, force_refresh: bool = False) -> List[types.Tool]:
    """
    Return MCP tools for discovery. Cache manifests for UI; return tools for
    callers that need raw definitions (not callable LangChain tools).
    """
    if settings.mcp.manifest_cache_enabled and _MCP_TOOL_MANIFEST_CACHE and not force_refresh:
        logger.info("mcp_tools_cache_hit", "Using cached MCP tool manifests", tool_count=len(_MCP_TOOL_MANIFEST_CACHE))
        return []
    
    tools = await _fetch_tools_from_gateway()
    if settings.mcp.manifest_cache_enabled:
        _prime_manifest_cache(tools)
        logger.info("mcp_tools_cache_refreshed", "MCP tool manifest cache refreshed", tool_count=len(_MCP_TOOL_MANIFEST_CACHE))
    
    return tools


@asynccontextmanager
async def mcp_session_context():
    """Yield an initialized MCP session, keeping the connection open for the caller."""
    endpoint = settings.mcp.mcp_gateway_url
    if not endpoint:
        raise MCPToolsClientError("MCP tools endpoint is not configured.")

    logger.info("mcp_session_starting", "Opening MCP session", upstream_service="mcp_gateway", endpoint=endpoint)
    async with sse_client(url=endpoint) as (read_stream, write_stream):
        async with mcp.ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            logger.info("mcp_session_ready", "MCP session initialized", upstream_service="mcp_gateway")
            try:
                yield session
            finally:
                logger.info("mcp_session_closed", "MCP session closed", upstream_service="mcp_gateway")
