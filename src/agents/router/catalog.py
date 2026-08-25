from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from core.security.internal_trust import require_internal_caller
from core.logging import get_logger
from schemas import AgentManifest, ToolManifest
from utils import MCPToolsClientError, get_cached_tool_manifests, list_mcp_tools
from utils.agents import AGENT_REGISTRY

logger = get_logger(__name__)

router = APIRouter()


@router.get(
    "/agents",
    response_model=List[AgentManifest],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_available_agents() -> List[AgentManifest]:
    """Return the discovered LangGraph agent manifests for downstream services."""
    manifests = [definition.manifest for definition in AGENT_REGISTRY.values()]
    manifests.sort(key=lambda item: item.get("name", ""))
    logger.info("agents_manifest_listed", "Served available agents", count=len(manifests))
    return [AgentManifest.model_validate(item) for item in manifests]


@router.get(
    "/tools",
    response_model=List[ToolManifest],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_available_tools() -> List[ToolManifest]:
    """Return the live tool catalog exposed by the MCP server."""
    cached_manifests = get_cached_tool_manifests()
    if cached_manifests:
        logger.info("tools_cache_hit", "Served tools from cache", count=len(cached_manifests))
        return cached_manifests

    try:
        await list_mcp_tools()
    except MCPToolsClientError as exc:
        logger.warning(
            "tools_refresh_failed",
            "Failed to refresh MCP tool manifests",
            exc_info=True,
            failure_reason="gateway_unavailable",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Tool catalog is temporarily unavailable.",
        ) from exc

    # list_mcp_tools primes the cache; return whatever was stored.
    manifests = get_cached_tool_manifests()
    logger.info("tools_cache_filled", "Refreshed tool catalog", count=len(manifests))
    return manifests
