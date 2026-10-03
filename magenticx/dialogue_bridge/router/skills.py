"""Skills router — the remote catalogue, a user's pool, and per-agent selection.

- ``GET /v1/skills/catalogue`` searches the remote skill catalogue (plan 30).
- ``GET / POST / DELETE /v1/skills/users/{user_id}[/...]`` manage the user's
  pool: add a remote skill, create a custom one, remove (cascades to every
  per-agent assignment).
- ``GET / PUT / DELETE /v1/skills/users/{user_id}/agents/{agent_id}[/{name}]``
  manage which pool skills are assigned to a deep agent.

Every route forwards to the agents service, which owns the skills in
``agent_runtime`` and is the only service that reaches a remote source. Nothing
here is stored or cached by the bridge.
"""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Path, Query, status
from core.logging import get_logger, set_context


from core.auth.session import AuthUser, require_csrf_protection, require_current_user
from core.security.rate_limit import (
    skill_catalogue_search_rate_limit,
    skill_remote_add_rate_limit,
    skill_upload_rate_limit,
)
from schema import (
    CatalogueSearchPage,
    CustomSkillCreateRequest,
    UserSkill,
    UserSkillDetail,
)
from utils import validate_userId
from utils.skills import (
    add_remote_skill_to_user_pool,
    create_custom_skill_in_pool,
    disable_user_agent_skill,
    enable_user_agent_skill,
    get_user_agent_skills,
    get_user_skill_detail,
    list_user_skills,
    remove_skill_from_user_pool,
    search_catalogue,
)

router = APIRouter()
logger = get_logger(__name__)


# Source and skill ids are lowercase ASCII with single hyphens wherever they are
# minted, so anything else is refused here rather than forwarded.
_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,63}$"


@router.get(
    "/catalogue",
    response_model=CatalogueSearchPage,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(skill_catalogue_search_rate_limit)],
)
async def search_skill_catalogue(
    q: str = Query("", max_length=200),
    source: str | None = Query(None, pattern=_ID_PATTERN),
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0, le=5000),
    _: AuthUser = Depends(require_current_user),
) -> CatalogueSearchPage:
    """Search the remote skill catalogue. Requires a valid session."""
    payload = await search_catalogue(query=q, source=source, limit=limit, offset=offset)
    return CatalogueSearchPage.model_validate(payload)


# ---------------------------------------------------------------------------
# Per-user pool
# ---------------------------------------------------------------------------
@router.get(
    "/users/{user_id}",
    response_model=List[UserSkill],
    status_code=status.HTTP_200_OK,
)
async def get_user_pool(
    user_id: str,
    _: AuthUser = Depends(validate_userId),
) -> List[UserSkill]:
    """Return the user's skill pool manifest (no content)."""
    set_context(user_id=user_id)
    payload = await list_user_skills(user_id=user_id)
    logger.info(
        "user_pool_listed",
        "Served user skill pool",
        user_id=user_id,
        count=len(payload),
    )
    return [UserSkill.model_validate(item) for item in payload]


@router.get(
    "/users/{user_id}/{skill_name}",
    response_model=UserSkillDetail,
    status_code=status.HTTP_200_OK,
)
async def get_user_skill(
    user_id: str,
    skill_name: str,
    _: AuthUser = Depends(validate_userId),
) -> UserSkillDetail:
    """Return a single user-pool skill with its content."""
    set_context(user_id=user_id)
    payload = await get_user_skill_detail(user_id=user_id, skill_name=skill_name)
    return UserSkillDetail.model_validate(payload)


@router.post(
    "/users/{user_id}/remote/{source_id}/{skill_id}",
    response_model=UserSkill,
    status_code=status.HTTP_201_CREATED,
)
async def add_remote_to_pool(
    user_id: str,
    source_id: str = Path(..., pattern=_ID_PATTERN),
    skill_id: str = Path(..., pattern=_ID_PATTERN),
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    # Each Add can make the agents service download a skill — per-user ceiling.
    # After auth + CSRF on purpose: the bucket is keyed on the path's {user_id},
    # so it must only ever count requests that user actually made.
    ___: None = Depends(skill_remote_add_rate_limit),
) -> UserSkill:
    """Add a remote skill to the user's pool, pinned to the version shown."""
    set_context(user_id=user_id)
    body = await add_remote_skill_to_user_pool(
        user_id=user_id, source_id=source_id, skill_id=skill_id
    )
    return UserSkill.model_validate(body)


@router.post(
    "/users/{user_id}/custom",
    response_model=UserSkill,
    status_code=status.HTTP_201_CREATED,
)
async def create_custom_skill(
    user_id: str,
    payload: CustomSkillCreateRequest,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    # Writes multi-file skills into agent_runtime — per-user ceiling.
    # After auth + CSRF on purpose: the bucket is keyed on the path's {user_id},
    # so it must only ever count requests that user actually made.
    ___: None = Depends(skill_upload_rate_limit),
) -> UserSkill:
    """Create a user-owned custom skill in the pool."""
    set_context(user_id=user_id)
    body = await create_custom_skill_in_pool(
        user_id=user_id, payload=payload.model_dump()
    )
    return UserSkill.model_validate(body)


@router.delete(
    "/users/{user_id}/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_from_pool(
    user_id: str,
    skill_name: str,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
) -> None:
    """Remove a skill from the user's pool, cascading to per-agent assignments."""
    set_context(user_id=user_id)
    await remove_skill_from_user_pool(user_id=user_id, skill_name=skill_name)


@router.get(
    "/users/{user_id}/agents/{agent_id}",
    response_model=List[str],
    status_code=status.HTTP_200_OK,
)
async def get_enabled_skills_for_user_agent(
    user_id: str,
    agent_id: str,
    _: AuthUser = Depends(validate_userId),
) -> List[str]:
    """Return the names of skills enabled for this (user, agent) pair.

    Read-through Redis cache with a short TTL; mutations always invalidate
    the matching key, so the TTL is just a safety net.
    """
    set_context(user_id=user_id, agent_id=agent_id)
    skills = await get_user_agent_skills(user_id=user_id, agent_id=agent_id)
    logger.info(
        "user_agent_skills_served",
        "Served per-(user, agent) skill selection",
        count=len(skills),
    )
    return skills


@router.put(
    "/users/{user_id}/agents/{agent_id}/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def enable_skill_for_user_agent(
    user_id: str,
    agent_id: str,
    skill_name: str,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
) -> None:
    """Enable ``skill_name`` for this (user, agent) pair.

    Idempotent: re-enabling an already-enabled skill is a no-op upstream.
    """
    set_context(user_id=user_id, agent_id=agent_id)
    await enable_user_agent_skill(
        user_id=user_id, agent_id=agent_id, skill_name=skill_name
    )


@router.delete(
    "/users/{user_id}/agents/{agent_id}/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def disable_skill_for_user_agent(
    user_id: str,
    agent_id: str,
    skill_name: str,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
) -> None:
    """Disable ``skill_name`` for this (user, agent) pair.

    Idempotent: disabling a not-enabled skill is a no-op upstream.
    """
    set_context(user_id=user_id, agent_id=agent_id)
    await disable_user_agent_skill(
        user_id=user_id, agent_id=agent_id, skill_name=skill_name
    )
