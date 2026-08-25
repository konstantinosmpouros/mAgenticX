"""Skills router — global catalog + per-user pool + per-(user, agent) selection.

Three tiers:

- ``GET /v1/skills`` returns the global admin-curated catalog.
- ``GET / POST / DELETE /v1/users/{user_id}/skills[/...]`` manage the
  user's personal pool — add globals by name, create owned customs,
  remove (cascades to per-agent assignments).
- ``GET / PUT / DELETE /v1/users/{user_id}/agents/{agent_id}/skills[/{name}]``
  manage which pool skills are assigned to a deep agent. The agents service
  resolves the source folder via the user's manifest at assignment time.

The bridge proxies to the agents service (which owns every volume) and
caches reads in Redis with short TTLs + explicit invalidation on every
mutation.

The selection state is **not stored in Postgres** — the on-disk filesystem
under ``$SKILLS_REGISTRY_USERS_ROOT/<user_id>/`` and
``$AGENTS_FILESYSTEM_ROOT/<user_id>/<agent_slug>/skills/`` IS the source of
truth.
"""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Query, status
from core.logging import get_logger, set_context

from core.auth.session import AuthUser, require_csrf_protection, require_current_user
from core.security.rate_limit import skill_upload_rate_limit
from schemas import (
    CustomSkillCreateRequest,
    Skill,
    UserSkill,
    UserSkillDetail,
)
from utils import validate_userId
from utils.skills import (
    add_global_skill_to_user_pool,
    create_custom_skill_in_pool,
    disable_user_agent_skill,
    enable_user_agent_skill,
    get_user_agent_skills,
    get_user_skill_detail,
    list_skills,
    list_user_skills,
    remove_skill_from_user_pool,
)

router = APIRouter()
logger = get_logger(__name__)


@router.get("", response_model=List[Skill], status_code=status.HTTP_200_OK)
async def get_skills(
    bypass_redis: bool = Query(
        default=False,
        description=(
            "When true, skip the Redis cache, fetch fresh from the agents "
            "service (forcing its in-memory manifest rebuild), and upsert "
            "the bridge cache with the response. Used by the manual "
            "'refresh' button. A normal page refresh leaves this false."
        ),
    ),
    _: AuthUser = Depends(require_current_user),
) -> List[Skill]:
    """Return every skill in the global catalog (admin-curated). Requires a valid session."""
    payload = await list_skills(bypass_cache=bypass_redis)
    logger.info(
        "skills_listed",
        "Served global skills catalog to UI",
        count=len(payload),
        bypass_redis=bypass_redis,
    )
    return [Skill.model_validate(item) for item in payload]


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
    bypass_redis: bool = Query(default=False),
    _: AuthUser = Depends(validate_userId),
) -> List[UserSkill]:
    """Return the user's skill pool manifest (no content)."""
    set_context(user_id=user_id)
    payload = await list_user_skills(user_id=user_id, bypass_cache=bypass_redis)
    logger.info(
        "user_pool_listed",
        "Served user skill pool",
        user_id=user_id,
        count=len(payload),
        bypass_redis=bypass_redis,
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
    """Return a single user-pool skill with its SKILL.md content (no cache)."""
    set_context(user_id=user_id)
    payload = await get_user_skill_detail(user_id=user_id, skill_name=skill_name)
    return UserSkillDetail.model_validate(payload)


@router.post(
    "/users/{user_id}/global/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def add_global_to_pool(
    user_id: str,
    skill_name: str,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
) -> None:
    """Append a global-skill reference to the user's pool."""
    set_context(user_id=user_id)
    await add_global_skill_to_user_pool(user_id=user_id, skill_name=skill_name)


@router.post(
    "/users/{user_id}/custom",
    response_model=UserSkill,
    status_code=status.HTTP_201_CREATED,
    # Writes multi-file folders onto the agents-service disk — per-user ceiling.
    dependencies=[Depends(skill_upload_rate_limit)],
)
async def create_custom_skill(
    user_id: str,
    payload: CustomSkillCreateRequest,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
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

    Proxies to the agents service which copies the registry's skill
    directory into the per-user filesystem. Idempotent: re-enabling an
    already-enabled skill is a no-op upstream.
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

    Proxies to the agents service which removes the skill's directory from
    the per-user filesystem. Idempotent: disabling a not-enabled skill is
    a no-op upstream.
    """
    set_context(user_id=user_id, agent_id=agent_id)
    await disable_user_agent_skill(
        user_id=user_id, agent_id=agent_id, skill_name=skill_name
    )
