import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Dict, List, Optional, Sequence

import mcp
from mcp import types
from mcp.client.sse import sse_client

from core.settings import settings
from core.logging import get_logger
from schema import ToolManifest

logger = get_logger(__name__)

class MCPToolsClientError(RuntimeError):
    """Raised when the MCP tools endpoint cannot be queried."""


_MCP_TOOL_MANIFEST_CACHE: Dict[str, ToolManifest] = {}
#: After a failed catalog fetch, fetches fail fast for this long (seconds).
#: Runs never consult it: each run tries the gateway itself, so a gateway that
#: comes back is picked up by the next chat at once.
_FETCH_RETRY_AFTER_SECONDS = 30.0
#: endpoint -> ``time.monotonic()`` until which a fetch is not retried. Keyed by
#: endpoint so a changed gateway URL is tried straight away.
_FETCH_FAILED_UNTIL: dict[str, float] = {}
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


async def _fetch_tools_from_gateway() -> list[types.Tool]:
    """Ask the gateway for its raw tools list (for the manifest cache).

    Opens through ``_gateway_session``, so a gateway that is down or never
    finishes its handshake costs at most the connect timeout — and only once per
    ``_FETCH_RETRY_AFTER_SECONDS``: a failure is remembered, and fetches inside
    that window fail fast with the same error instead of each waiting it out
    again (a cold cache would otherwise stall every Agents-page call).
    """
    endpoint = settings.mcp.mcp_gateway_url
    if time.monotonic() < _FETCH_FAILED_UNTIL.get(endpoint, 0.0):
        logger.info("mcp_tools_fetch_skipped", "MCP gateway failed recently; not retrying yet", upstream_service="mcp_gateway", endpoint=endpoint)
        raise MCPToolsClientError("MCP gateway failed recently; not retrying yet.")

    try:
        logger.info("mcp_tools_fetch_started", "MCP tools fetch started", upstream_service="mcp_gateway", endpoint=endpoint)
        async with _gateway_session(endpoint) as session:
            result = await session.list_tools()
    except Exception as exc:
        _FETCH_FAILED_UNTIL[endpoint] = time.monotonic() + _FETCH_RETRY_AFTER_SECONDS
        logger.warning(
            "mcp_tools_fetch_failed",
            "Failed to fetch tools from MCP gateway",
            exc_info=True,
            upstream_service="mcp_gateway",
            failure_reason="gateway_error",
            exception_type=type(exc).__name__,
            retry_after_seconds=_FETCH_RETRY_AFTER_SECONDS,
        )
        raise MCPToolsClientError("Failed to list tools from MCP server.") from exc

    _FETCH_FAILED_UNTIL.pop(endpoint, None)
    tools = list(result.tools)
    logger.info("mcp_tools_fetch_completed", "MCP tools fetch completed", upstream_service="mcp_gateway", tool_count=len(tools))
    return tools


async def list_mcp_tools(*, force_refresh: bool = False) -> List[types.Tool]:
    """
    Return MCP tools for discovery. Cache manifests for UI; return tools for
    callers that need raw definitions (not callable LangChain tools).
    """
    if not settings.mcp.enabled:
        return []  # MCP turned off: an empty catalog, not an error
    if settings.mcp.manifest_cache_enabled and _MCP_TOOL_MANIFEST_CACHE and not force_refresh:
        logger.info("mcp_tools_cache_hit", "Using cached MCP tool manifests", tool_count=len(_MCP_TOOL_MANIFEST_CACHE))
        return []

    tools = await _fetch_tools_from_gateway()
    if settings.mcp.manifest_cache_enabled:
        _prime_manifest_cache(tools)
        logger.info("mcp_tools_cache_refreshed", "MCP tool manifest cache refreshed", tool_count=len(_MCP_TOOL_MANIFEST_CACHE))

    return tools


async def known_mcp_tool_keys() -> Optional[frozenset[str]]:
    """The gateway's tools as ``server/tool`` keys, for checking an agent spec.

    Empty when MCP is off on this deployment; ``None`` when the catalog could
    not be read (gateway down, or the manifest cache is disabled), which the
    caller reports as "could not check" rather than as unknown tools.
    """
    if not settings.mcp.enabled:
        return frozenset()
    if not _MCP_TOOL_MANIFEST_CACHE:
        try:
            await list_mcp_tools()
        except MCPToolsClientError:
            logger.warning(
                "mcp_tool_keys_unavailable",
                "Could not read the MCP catalog to check an agent's tools",
                failure_reason="gateway_unavailable",
            )
            return None
    if not _MCP_TOOL_MANIFEST_CACHE:
        return None
    return frozenset(f"{m.server_id}/{m.tool_name}" for m in _MCP_TOOL_MANIFEST_CACHE.values())


@asynccontextmanager
async def _gateway_session(endpoint: str) -> AsyncIterator[mcp.ClientSession]:
    """Connect to the gateway and finish the MCP handshake within the connect timeout.

    The one place the connect deadline lives — the catalog fetch and every run's
    session open through here. Connecting plus ``initialize()`` get
    ``connect_timeout_seconds`` between them; then the deadline is lifted, so
    whatever the caller does with the live session is never cut short by it.
    A refused connection raises as is; a missed deadline raises ``TimeoutError``.
    """
    timeout_seconds = settings.mcp.connect_timeout_seconds
    async with asyncio.timeout(timeout_seconds) as deadline:
        async with (
            sse_client(url=endpoint, timeout=timeout_seconds) as (read_stream, write_stream),
            mcp.ClientSession(read_stream, write_stream) as session,
        ):
            await session.initialize()
            deadline.reschedule(None)  # connected: the caller's work has no deadline
            yield session


@asynccontextmanager
async def optional_mcp_session():
    """Yield an initialized MCP session, or ``None`` when MCP is not available.

    MCP is optional (``McpSettings``). With no gateway URL configured this yields
    ``None`` without touching the network; with one configured, a gateway that is
    down, unknown, or slow to finish its handshake also yields ``None`` — logged
    as ``mcp_session_unavailable`` — so the run goes ahead with the agent's own
    tools instead of failing. A missing MCP server costs its tools, not the chat.

    Only connecting and the handshake are covered (``_gateway_session``): anything
    raised by the caller's own work inside the block propagates unchanged — it is
    never mistaken for a gateway outage.
    """
    if not settings.mcp.enabled:
        logger.info("mcp_disabled", "MCP gateway not configured; running without MCP tools")
        yield None
        return

    endpoint = settings.mcp.mcp_gateway_url
    ready = False
    try:
        logger.info("mcp_session_starting", "Opening MCP session", upstream_service="mcp_gateway", endpoint=endpoint)
        async with _gateway_session(endpoint) as session:
            ready = True
            logger.info("mcp_session_ready", "MCP session initialized", upstream_service="mcp_gateway")
            try:
                yield session
            finally:
                logger.info("mcp_session_closed", "MCP session closed", upstream_service="mcp_gateway")
    except Exception as exc:
        if ready:
            raise  # the caller's work (or closing a live session) failed — not ours to swallow
        logger.warning(
            "mcp_session_unavailable",
            "MCP gateway unavailable; running without MCP tools",
            upstream_service="mcp_gateway",
            endpoint=endpoint,
            exception_type=type(exc).__name__,
            timeout_seconds=settings.mcp.connect_timeout_seconds,
        )
    if not ready:
        yield None
