"""Per-agent tool endpoints (Agents tab).

Thin handlers over ``utils.agent_tools``: list the tools an agent can use with
their baseline state. Internal-caller only
(the bridge proxies these). Tool *catalog* inspection (MCP servers) is the
existing ``GET /tools`` in ``catalog.py``; this router is the per-agent view.
"""
from fastapi import APIRouter, Depends, HTTPException, status

from core.security.internal_trust import require_internal_caller
from core.logging import get_logger
from schema import AgentToolsResponse
from utils.agent_tools import list_agent_tools
from utils.mcp_tools import MCPToolsClientError, list_mcp_tools

logger = get_logger(__name__)

router = APIRouter()


@router.get(
    "/agents/{user_id}/{agent_slug}/tools",
    response_model=AgentToolsResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_agent_tools(
    user_id: str,
    agent_slug: str,
    use_memory: bool = True,
    search_past_convs: bool = False,
) -> AgentToolsResponse:
    """Every tool this agent can have, with the baseline this service knows.

    The two preference flags are passed by the bridge, which owns them: they
    decide whether the memory builtins are present for this user.
    """
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
    rows = list_agent_tools(
        user_id,
        agent_slug,
        use_memory=use_memory,
        search_past_convs=search_past_convs,
    )
    if rows is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")
    return AgentToolsResponse(agentSlug=agent_slug, tools=rows)
