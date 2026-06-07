"""Skills router — registry catalogue + per-(user, agent) selection CRUD.

Phase 1: ``GET /v1/skills`` returns the central read-only catalogue.
Phase 2: ``GET / PUT / DELETE /v1/users/{user_id}/agents/{agent_id}/skills[/{name}]``
manage which skills are enabled for a specific (user, agent) pair. The bridge
proxies to the agents service (which owns the per-user filesystem) and
caches selection lists in Redis with a short TTL + explicit invalidation
on every mutation.

The selection state is **not stored in Postgres** — the on-disk directory
under ``<filesystem_root>/<user_id>/<agent_slug>/skills/`` IS the source of
truth.
"""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Query, status
from observability import get_logger, set_context

from core.auth_session import require_csrf_protection
from core.database import UserTable
from schemas import Skill
from utils import validate_userId
from utils.skills import (
    disable_user_agent_skill,
    enable_user_agent_skill,
    get_user_agent_skills,
    list_skills,
)

router = APIRouter()
logger = get_logger(__name__)


@router.get("", response_model=List[Skill], status_code=status.HTTP_200_OK)
async def get_skills(
    bypass_redis: bool = Query(
        default=False,
        description=(
            "When true, skip the Redis cache, fetch fresh from the agents "
            "service, and upsert the cache with the response. Used by the "
            "manual 'refresh' button in the Skills tab. A normal page refresh "
            "leaves this false so it benefits from the cache."
        ),
    ),
) -> List[Skill]:
    """Return every skill in the central registry.

    Proxies the agents service ``GET /skills`` with the trusted-proxy header.
    Reads go through Redis with a TTL unless ``bypass_redis=true`` is set.
    """
    payload = await list_skills(bypass_cache=bypass_redis)
    logger.info(
        "skills_listed",
        "Served skills registry to UI",
        count=len(payload),
        bypass_redis=bypass_redis,
    )
    return [Skill.model_validate(item) for item in payload]


@router.get(
    "/users/{user_id}/agents/{agent_id}",
    response_model=List[str],
    status_code=status.HTTP_200_OK,
)
async def get_enabled_skills_for_user_agent(
    user_id: str,
    agent_id: str,
    _: UserTable = Depends(validate_userId),
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
    _: UserTable = Depends(validate_userId),
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
    _: UserTable = Depends(validate_userId),
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
