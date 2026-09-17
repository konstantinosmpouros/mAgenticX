"""Per-agent tool endpoints (Agents tab) — thin proxy to the agents service.

Lists the tools an agent can use with their per-(user, agent) state, toggles one
on or off, and sets whether one pauses for human approval. User-scoped
(``validate_userId`` ensures the path user matches the session); both mutating
routes additionally require a CSRF token.

No longer a pure proxy: the *manifest* still comes from the agents service (only
it can see which tools exist), while the user's on/off choices are owned by
``chat_db``. Business logic lives in ``utils.agents`` (``fetch_agent_tools`` /
``set_agent_tool_disabled``) over ``utils.agent_tool_prefs``.
"""
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.logging import get_logger, set_context
from core.auth.session import AuthUser, require_csrf_protection
from schema import AgentToolsResponse, ToolApprovalRequest, ToolEnabledRequest
from utils import (
    fetch_agent_tools,
    set_agent_tool_approval,
    set_agent_tool_enabled,
    validate_userId,
)

router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/{user_id}/{agent_id}/tools",
    response_model=AgentToolsResponse,
    status_code=status.HTTP_200_OK,
)
async def get_agent_tools(
    user_id: str,
    agent_id: str,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> AgentToolsResponse:
    """The tools this agent can use + their per-(user, agent) state."""
    set_context(user_id=user_id)
    payload = await fetch_agent_tools(db, user_id, agent_id)
    return AgentToolsResponse.model_validate(payload)


@router.post(
    "/{user_id}/{agent_id}/tools/enabled",
    response_model=AgentToolsResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_csrf_protection)],
)
async def set_agent_tool_enabled_state(
    user_id: str,
    agent_id: str,
    body: ToolEnabledRequest,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> AgentToolsResponse:
    """Switch one MCP tool on or off for this (user, agent)."""
    set_context(user_id=user_id)
    payload = await set_agent_tool_enabled(db, user_id, agent_id, body.toolKey, body.enabled)
    logger.info(
        "agent_tool_enabled_set",
        "Set per-agent MCP tool enablement",
        agent_id=agent_id,
        tool_key=body.toolKey,
        enabled=body.enabled,
    )
    return AgentToolsResponse.model_validate(payload)


@router.post(
    "/{user_id}/{agent_id}/tools/approval",
    response_model=AgentToolsResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_csrf_protection)],
)
async def set_agent_tool_approval_gate(
    user_id: str,
    agent_id: str,
    body: ToolApprovalRequest,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> AgentToolsResponse:
    """Gate/ungate one tool behind human approval; returns refreshed rows."""
    set_context(user_id=user_id)
    payload = await set_agent_tool_approval(
        db, user_id, agent_id, body.toolKey, body.approval
    )
    logger.info(
        "agent_tool_approval_set",
        "Set per-agent tool approval gate",
        agent_id=agent_id,
        tool_key=body.toolKey,
        approval=body.approval,
    )
    return AgentToolsResponse.model_validate(payload)
