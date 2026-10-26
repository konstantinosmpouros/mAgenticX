"""User-authored agent endpoints (the agent builder).

Mounted under ``/v1/agents`` alongside the per-agent tools routes. Every route is
user-scoped: ``validate_userId`` ties the path user to the session, and each
handler additionally verifies the target agent is owned by that user (a 404, not
a 403, so someone else's id is indistinguishable from a nonexistent one).
Mutations require a CSRF token.

Literal segments (``validate``, ``import``) are declared before the
``{agent_id}`` routes, and this router is mounted before the tools router
(``main.py``), so a literal is never read as an agent id.

Business logic — the agents-service proxy and the catalog-row lifecycle — lives
in ``utils.user_agents``; these handlers stay thin.
"""
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection
from core.database import get_db
from core.logging import get_logger, set_context
from core.security.rate_limit import agent_import_rate_limit
from schema import (
    AgentPublic,
    CustomAgentDetail,
    CustomAgentImportResult,
    CustomAgentValidation,
    CustomAgentWrite,
)
from utils import validate_userId
from utils.user_agents import (
    create_custom_agent,
    delete_custom_agent,
    export_custom_agent,
    get_custom_agent_definition,
    import_custom_agent,
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
    include: Literal["summary"] | None = Query(
        None,
        description="`summary` adds model and tool/skill/sub-agent counts (one agents-service call).",
    ),
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> list[AgentPublic]:
    """The agents this user authored, in the same shape as the agent catalog."""
    set_context(user_id=user_id)
    items = await list_custom_agent_definitions(
        db, user_id, include_summary=include == "summary"
    )
    return [AgentPublic.model_validate(item) for item in items]


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
    "/{user_id}/custom/import",
    response_model=CustomAgentImportResult,
    status_code=status.HTTP_200_OK,
)
async def import_my_agent(
    user_id: str,
    yaml: str | None = Form(None),
    files: list[UploadFile] | None = File(None),
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    # Unpacks an upload in memory and has the agents service parse it — per-user
    # ceiling. After auth + CSRF on purpose: the bucket is keyed on the path's
    # {user_id}, so it must only ever count requests that user actually made.
    ___: None = Depends(agent_import_rate_limit),
) -> CustomAgentImportResult:
    """Check an ``agent.yaml`` (text or file, with its files) or one ``.zip``.

    Saves nothing: the builder opens the result as a draft, and Create saves it.
    """
    set_context(user_id=user_id)
    result = await import_custom_agent(user_id, yaml, files or [])
    return CustomAgentImportResult.model_validate(result)


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


@router.get(
    "/{user_id}/custom/{agent_id}/export",
    status_code=status.HTTP_200_OK,
    response_class=Response,
    responses={200: {"content": {"application/zip": {}}}},
)
async def export_my_agent(
    user_id: str,
    agent_id: str,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """An owned agent as a ``.zip``: ``agent.yaml`` plus every file it carries."""
    set_context(user_id=user_id)
    export = await export_custom_agent(db, user_id, agent_id)
    return Response(
        content=export["content"],
        media_type=export["media_type"],
        headers={
            "Content-Disposition": export["content_disposition"],
            "Cache-Control": "no-store",
        },
    )


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
