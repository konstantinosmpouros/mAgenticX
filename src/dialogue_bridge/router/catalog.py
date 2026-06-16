from fastapi import APIRouter, Depends, Query, status
from observability import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db, UserTable
from schemas import AgentPublic, ToolManifest
from utils import (
    fetch_tools_from_agents_service,
    generate_conversation_suggestions,
    get_agent_by_id,
    get_cached_agents,
    recent_conversations_for_suggestions,
    sync_agents_with_service,
    validate_userId,
)
from core.auth_session import require_current_user


router = APIRouter()
logger = get_logger(__name__)


@router.get("/agents", response_model=list[AgentPublic], status_code=status.HTTP_200_OK)
async def get_available_agents(_: UserTable = Depends(require_current_user), db: AsyncSession = Depends(get_db)):
    """
    Return the active agents, preferring the in-memory cache and refreshing
    from the agents service only when the cache is empty.
    """
    agents = get_cached_agents()
    if agents:
        logger.info("agents_cache_hit", "Served agents from cache", count=len(agents))
    if not agents:
        logger.info("agents_cache_miss", "Agent cache empty; synchronizing with agents service")
        agents = await sync_agents_with_service(db)
    return [AgentPublic.model_validate(a) for a in agents]


@router.get("/tools", response_model=list[ToolManifest], status_code=status.HTTP_200_OK)
async def get_available_tools(_: UserTable = Depends(require_current_user)):
    """Return the tools exposed by the MCP server via the agents service."""
    payload = await fetch_tools_from_agents_service()
    logger.info("tools_fetched", "Fetched tools from agents service", count=len(payload))
    return [ToolManifest.model_validate(item) for item in payload]


@router.get(
    "/{user_id}/suggestions",
    response_model=dict[str, list[str]],
    status_code=status.HTTP_200_OK,
    summary="Generate personalized starter suggestions for a new chat",
)
async def getSuggestions(
    user_id: str,
    agentId: str | None = Query(None),
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """Generate starter suggestions from recent non-private user context."""
    set_context(user_id=user_id)
    agent = await get_agent_by_id(agentId) if agentId else None

    recent_conversations = await recent_conversations_for_suggestions(db, current_user.id)
    suggestions = await generate_conversation_suggestions(
        agent_name=agent.name if agent else None,
        agent_description=agent.description if agent else None,
        recent_conversations=recent_conversations,
    )
    logger.info(
        "suggestions_fetched",
        "Suggestions fetched",
        candidate_count=len(suggestions),
        recent_conversation_count=len(recent_conversations),
    )
    return {"suggestions": suggestions}
