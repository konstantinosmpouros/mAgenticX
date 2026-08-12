from fastapi import APIRouter, Depends, Query, status
from observability import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from schemas import AgentPublic, ToolManifest
from utils import (
    fetch_tools_from_agents_service,
    generate_conversation_suggestions,
    get_agent_by_id,
    get_cached_agents,
    list_user_agents,
    recent_conversations_for_suggestions,
    sync_agents_with_service,
    validate_userId,
)
from core.auth.session import require_current_user, AuthUser
from core.security.rate_limit import suggestions_rate_limit


router = APIRouter()
logger = get_logger(__name__)


@router.get("/agents", response_model=list[AgentPublic], status_code=status.HTTP_200_OK)
async def get_available_agents(user: AuthUser = Depends(require_current_user), db: AsyncSession = Depends(get_db)):
    """
    Return the agents this caller may use: every active platform agent, plus the
    agents they authored themselves.

    Platform agents come from the in-memory cache (refreshed from the agents
    service only when empty). User-authored agents are read per-request and
    scoped to the caller — they are deliberately absent from the cache, which is
    process-global and would otherwise expose one user's agents to everyone.
    """
    agents = get_cached_agents()
    if agents:
        logger.info("agents_cache_hit", "Served agents from cache", count=len(agents))
    if not agents:
        logger.info("agents_cache_miss", "Agent cache empty; synchronizing with agents service")
        agents = await sync_agents_with_service(db)

    owned = await list_user_agents(db, user.id)
    if owned:
        logger.info("user_agents_listed", "Included user-authored agents", count=len(owned))
    return [AgentPublic.model_validate(a) for a in [*agents, *owned]]


@router.get("/tools", response_model=list[ToolManifest], status_code=status.HTTP_200_OK)
async def get_available_tools(_: AuthUser = Depends(require_current_user)):
    """Return the tools exposed by the MCP server via the agents service."""
    payload = await fetch_tools_from_agents_service()
    logger.info("tools_fetched", "Fetched tools from agents service", count=len(payload))
    return [ToolManifest.model_validate(item) for item in payload]


@router.get(
    "/{user_id}/suggestions",
    response_model=dict[str, list[str]],
    status_code=status.HTTP_200_OK,
    summary="Generate personalized starter suggestions for a new chat",
    # Proxies an LLM generation call on the agents service — per-user ceiling.
    dependencies=[Depends(suggestions_rate_limit)],
)
async def getSuggestions(
    user_id: str,
    agentId: str | None = Query(None),
    current_user: AuthUser = Depends(validate_userId),
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
