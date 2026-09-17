"""User-authored agent endpoints (the agent builder).

Mounted under ``/v1/agents`` alongside the per-agent tools routes. Every route is
user-scoped: ``validate_userId`` ties the path user to the session, and each
handler additionally verifies the target agent is owned by that user (a 404, not
a 403, so someone else's id is indistinguishable from a nonexistent one).
Mutations require a CSRF token.

Business logic — the agents-service proxy and the catalog-row lifecycle — lives
in ``utils.user_agents``; these handlers stay thin.
"""
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection
from core.database import get_db
from core.logging import get_logger, set_context
from schema import AgentPublic, CustomAgentDetail, CustomAgentValidation, CustomAgentWrite
from utils import validate_userId
from utils.user_agents import (
    create_custom_agent,
    delete_custom_agent,
    get_custom_agent_definition,
    list_custom_agent_definitions,
    update_custom_agent,
    validate_custom_agent_definition,
)

router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/{user_id}/custom",
    response_model=list[AgentPublic],
    status_code=status.HTTP_200_OK,
)
async def list_my_agents(
    user_id: str,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> list[AgentPublic]:
    """The agents this user authored, in the same shape as the agent catalog."""
    set_context(user_id=user_id)
    items = await list_custom_agent_definitions(db, user_id)
    return [
        AgentPublic(
            id=item["id"],
            name=item.get("name") or item.get("slug") or "",
            description=item.get("description") or "",
            icon=item.get("icon") or "",
            version=item.get("version"),
            type=item.get("type") or "deep agent",
            is_active=True,
        )
        for item in items
    ]


@router.get(
    "/{user_id}/custom/{agent_id}",
    response_model=CustomAgentDetail,
    status_code=status.HTTP_200_OK,
)
async def get_my_agent(
    user_id: str,
    agent_id: str,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> CustomAgentDetail:
    """One owned agent's full definition, for the edit view."""
    set_context(user_id=user_id)
    detail = await get_custom_agent_definition(db, user_id, agent_id)
    return CustomAgentDetail.model_validate(detail)


@router.post(
    "/{user_id}/custom/validate",
    response_model=CustomAgentValidation,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_csrf_protection)],
)
async def validate_my_agent(
    user_id: str,
    payload: CustomAgentWrite,
    _: AuthUser = Depends(validate_userId),
) -> CustomAgentValidation:
    """Dry run so the builder can show every problem before saving."""
    set_context(user_id=user_id)
    result = await validate_custom_agent_definition(user_id, payload.model_dump(mode="json"))
    return CustomAgentValidation.model_validate(result)


@router.post(
    "/{user_id}/custom",
    response_model=AgentPublic,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf_protection)],
)
async def create_my_agent(
    user_id: str,
    payload: CustomAgentWrite,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> AgentPublic:
    """Create an agent from a validated definition."""
    set_context(user_id=user_id)
    row = await create_custom_agent(db, user_id, payload.model_dump(mode="json"))
    return AgentPublic.model_validate(row)


@router.put(
    "/{user_id}/custom/{agent_id}",
    response_model=AgentPublic,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_csrf_protection)],
)
async def update_my_agent(
    user_id: str,
    agent_id: str,
    payload: CustomAgentWrite,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> AgentPublic:
    """Replace an owned agent's definition."""
    set_context(user_id=user_id)
    row = await update_custom_agent(db, user_id, agent_id, payload.model_dump(mode="json"))
    return AgentPublic.model_validate(row)


@router.delete(
    "/{user_id}/custom/{agent_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_protection)],
)
async def delete_my_agent(
    user_id: str,
    agent_id: str,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete an owned agent's definition. Conversations it produced are kept."""
    set_context(user_id=user_id)
    await delete_custom_agent(db, user_id, agent_id)
