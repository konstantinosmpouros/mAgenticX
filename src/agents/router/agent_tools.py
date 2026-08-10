"""Per-agent tool endpoints (Agents tab).

Thin handlers over ``utils.agent_tools``: list the tools an agent can use with
their per-(user, agent) disabled state, and toggle one. Internal-caller only
(the bridge proxies these). Tool *catalog* inspection (MCP servers) is the
existing ``GET /tools`` in ``catalog.py``; this router is the per-agent view.
"""
from fastapi import APIRouter, Depends, HTTPException, status

from core.proxy import require_internal_caller
from observability import get_logger
from schemas import AgentToolsResponse, ToolToggleRequest
from utils.agent_tools import list_agent_tools, toggle_agent_tool
from utils.mcp_tools import MCPToolsClientError, list_mcp_tools

logger = get_logger(__name__)

router = APIRouter()


@router.get(
    "/agents/{user_id}/{agent_slug}/tools",
    response_model=AgentToolsResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_agent_tools(user_id: str, agent_slug: str) -> AgentToolsResponse:
    """List the tools this agent can use + their per-(user, agent) disabled state."""
    # Warm the MCP manifest cache first: list_agent_tools reads the cached
    # manifest map for the "available to add" catalog, and that cache is primed
    # only by this discovery path (the per-stream loader never touches it). Cheap
    # when already warm (internal cache-hit, no gateway call); a gateway outage
    # just leaves the catalog empty, declared tools still list.
    try:
        await list_mcp_tools()
    except MCPToolsClientError:
        logger.warning(
            "agent_tools_catalog_warm_failed",
            "MCP gateway unavailable while listing agent tools; catalog will be empty",
            agent_slug=agent_slug,
        )
    rows = list_agent_tools(user_id, agent_slug)
    if rows is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")
    return AgentToolsResponse(agentSlug=agent_slug, tools=rows)


@router.post(
    "/agents/{user_id}/{agent_slug}/tools/toggle",
    response_model=AgentToolsResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def toggle_agent_tool_endpoint(
    user_id: str, agent_slug: str, body: ToolToggleRequest
) -> AgentToolsResponse:
    """Enable/disable one tool for this (user, agent) and return refreshed rows."""
    try:
        rows = toggle_agent_tool(user_id, agent_slug, body.toolKey, body.disabled)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if rows is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")
    logger.info(
        "agent_tool_toggled",
        "Toggled per-agent tool disable state",
        agent_slug=agent_slug,
        tool_key=body.toolKey,
        disabled=body.disabled,
    )
    return AgentToolsResponse(agentSlug=agent_slug, tools=rows)
