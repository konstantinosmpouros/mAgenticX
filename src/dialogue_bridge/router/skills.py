"""Skills router — exposes the agents-service skills registry to the agentic UI.

Phase 1 ships a single read-only endpoint. Phase 2 extends this module with
per-(user, agent) selection CRUD that mutates the per-user filesystem on the
agents service and invalidates the bridge-side Redis cache.

GETs are public to authenticated sessions; mutations land in Phase 2 with
CSRF protection.
"""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Query, status
from observability import get_logger

from schemas import Skill
from utils.skills import list_skills

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
