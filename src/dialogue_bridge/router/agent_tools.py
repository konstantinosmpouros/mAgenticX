"""Per-agent tool endpoints (Agents tab) — thin proxy to the agents service.

Lists the tools an agent can use with their per-(user, agent) override state and
toggles one. User-scoped (``validate_userId`` ensures the path user matches the
session); the mutating toggle additionally requires a CSRF token.

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
from schema import AgentToolsResponse, ToolToggleRequest
from utils import fetch_agent_tools, set_agent_tool_disabled, validate_userId

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
    """The tools this agent can use + their per-(user, agent) disabled state."""
    set_context(user_id=user_id)
    payload = await fetch_agent_tools(db, user_id, agent_id)
    return AgentToolsResponse.model_validate(payload)


@router.post(
    "/{user_id}/{agent_id}/tools/toggle",
    response_model=AgentToolsResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_csrf_protection)],
)
async def toggle_agent_tool(
    user_id: str,
    agent_id: str,
    body: ToolToggleRequest,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> AgentToolsResponse:
    """Enable/disable one tool for this (user, agent); returns refreshed rows."""
    set_context(user_id=user_id)
    payload = await set_agent_tool_disabled(
        db, user_id, agent_id, body.toolKey, body.disabled
    )
    logger.info(
        "agent_tool_toggled",
        "Toggled per-agent tool disable state",
        agent_id=agent_id,
        tool_key=body.toolKey,
        disabled=body.disabled,
    )
    return AgentToolsResponse.model_validate(payload)
