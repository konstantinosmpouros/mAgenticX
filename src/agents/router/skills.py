from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from core.proxy import require_internal_caller
from observability import get_logger
from runtime.skill_registry import (
    SkillNameConflict,
    add_custom_to_user,
    add_global_to_user,
    get_user_skill_detail,
    list_user_skills,
    rebuild_global_manifest,
    remove_from_user,
)
from schemas import (
    CustomSkillCreate,
    SkillManifest,
    SkillManifestEntry,
    UserSkillDetail,
)
from utils import (
    disable_user_agent_skill,
    enable_user_agent_skill,
    list_registry_skills,
    list_user_agent_skills,
)

logger = get_logger(__name__)

router = APIRouter()


# ------------------------------------------------------------------
# Global Skills Registry
# ------------------------------------------------------------------
@router.get(
    "/skills/global",
    response_model=List[SkillManifest],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_global_skills(bypass_cache: bool = False) -> List[SkillManifest]:
    """Return the global skills catalog (admin-curated).

    With ``bypass_cache=true`` the agents service rescans the global volume
    + rewrites manifest.json before responding — used by the UI's refresh
    button when an admin has dropped a new skill into the volume.

    The bridge caches the result in Redis (24 h TTL); ``bypass_cache=true``
    also bypasses the bridge cache and refreshes it.
    """
    if bypass_cache:
        rebuild_global_manifest()
    skills = list_registry_skills()
    logger.info(
        "skills_global_listed",
        "Served global skills catalog",
        count=len(skills),
        bypass_cache=bypass_cache,
    )
    return skills


# ------------------------------------------------------------------
# Per-User Skill Pool (manifest-driven)
# ------------------------------------------------------------------
# Each user has a manifest.json under $SKILLS_REGISTRY_USERS_ROOT/<user_id>/
# listing the skills in their pool. Pool entries reference either global
# skills (no folder copy needed) or owned custom skills (folder lives in
# users/<user_id>/custom/<name>/). The per-(user, agent) PUT below resolves
# its source through this manifest — users can only assign skills they have
# in their pool.
@router.get(
    "/users/{user_id}/skills",
    response_model=List[SkillManifestEntry],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_skill_pool(user_id: str) -> List[SkillManifestEntry]:
    """Return the user's manifest entries (no SKILL.md content, descriptions only)."""
    try:
        entries = list_user_skills(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info(
        "user_skill_pool_listed",
        "Served user skill pool",
        user_id=user_id,
        count=len(entries),
    )
    return entries


@router.get(
    "/users/{user_id}/skills/{skill_name}",
    response_model=UserSkillDetail,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_skill_detail_endpoint(user_id: str, skill_name: str) -> UserSkillDetail:
    """Return one skill from the user's pool with its SKILL.md content."""
    try:
        return get_user_skill_detail(user_id, skill_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post(
    "/users/{user_id}/skills/global/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def add_global_skill_to_user(user_id: str, skill_name: str) -> None:
    """Append a reference to a global skill into the user's pool (manifest-only)."""
    try:
        add_global_to_user(user_id, skill_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post(
    "/users/{user_id}/skills/custom",
    response_model=SkillManifestEntry,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_internal_caller)],
)
async def create_user_custom_skill(user_id: str, payload: CustomSkillCreate) -> SkillManifestEntry:
    """Create a user-owned custom skill (multi-file folder + manifest entry).

    409 on a name collision (with a global OR another pool entry); 422 on a
    structural validation failure (bad path, oversized file, disallowed type,
    invalid base64, or a missing SKILL.md).
    """
    try:
        return add_custom_to_user(user_id, payload)
    except SkillNameConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.delete(
    "/users/{user_id}/skills/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def delete_user_skill(user_id: str, skill_name: str) -> None:
    """Remove a skill from the user's pool and cascade-remove from per-agent assignments."""
    try:
        remove_from_user(user_id, skill_name)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


# ------------------------------------------------------------------
# Per-(user, agent) skill selection
# ------------------------------------------------------------------
# The on-disk directory layout under <filesystem_root>/<user_id>/<agent_slug>/
# IS the selection state — there is no DB row mirroring it. These three
# endpoints are the only writers after a (user, agent) pair's first run; the
# DeepAgent runtime reads the same directory via its CompositeBackend
# ``/agent/skills/`` route at build time.
@router.get(
    "/agents/{agent_slug}/users/{user_id}/skills",
    response_model=List[str],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_agent_skills(agent_slug: str, user_id: str) -> List[str]:
    """Return the sorted list of skill names enabled for this (user, agent)."""
    try:
        skills = list_user_agent_skills(user_id=user_id, agent_slug=agent_slug)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info(
        "user_agent_skills_listed",
        "Served per-(user, agent) enabled skills",
        user_id=user_id,
        agent_slug=agent_slug,
        count=len(skills),
    )
    return skills


@router.put(
    "/agents/{agent_slug}/users/{user_id}/skills/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def enable_skill_for_user_agent(agent_slug: str, user_id: str, skill_name: str) -> None:
    """Enable ``skill_name`` for this (user, agent) by copying it from the registry."""
    try:
        enable_user_agent_skill(user_id=user_id, agent_slug=agent_slug, skill_name=skill_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.delete(
    "/agents/{agent_slug}/users/{user_id}/skills/{skill_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def disable_skill_for_user_agent(agent_slug: str, user_id: str, skill_name: str) -> None:
    """Disable ``skill_name`` for this (user, agent) by removing its directory."""
    try:
        disable_user_agent_skill(user_id=user_id, agent_slug=agent_slug, skill_name=skill_name)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
