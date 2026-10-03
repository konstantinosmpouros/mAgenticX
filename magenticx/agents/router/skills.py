"""Skill routes: the remote catalogue search, a user's pool and its per-agent
assignments. Every route is internal (the bridge is the caller) and thin — the
rules live in ``harness.skill_registry``."""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status

from core.security.internal_trust import require_internal_caller
from core.logging import get_logger
from harness.skill_registry import (
    RemoteSkillRefused,
    RemoteSkillUnavailable,
    RemoteSkillsDisabled,
    SkillNameConflict,
    add_custom_to_user,
    add_remote_to_user,
    assign_user_skill_to_agent,
    get_user_skill_detail,
    list_remote_sources,
    list_user_skills,
    list_user_agent_skills,
    remove_from_user,
    search_catalogue,
    unassign_user_skill_from_agent,
)
from schema import (
    CatalogueSearchPage,
    CustomSkillCreate,
    RemoteSourceStatus,
    SkillManifestEntry,
    UserSkillDetail,
)

logger = get_logger(__name__)

router = APIRouter()


# ------------------------------------------------------------------
# Catalogue search + remote sources (plan 30)
# ------------------------------------------------------------------
# Source and skill ids are lowercase ASCII with single hyphens everywhere they
# are minted, so anything else is refused at the edge rather than looked up.
_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,63}$"


@router.get(
    "/skills/catalogue/search",
    response_model=CatalogueSearchPage,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def search_skill_catalogue(
    q: str = Query("", max_length=200),
    source: Optional[str] = Query(None, pattern=_ID_PATTERN),
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0, le=5000),
) -> CatalogueSearchPage:
    """Full-text search over platform and admitted remote skills, paginated."""
    page = await search_catalogue(q, source_id=source, limit=limit, offset=offset)
    logger.info(
        "skill_catalogue_searched",
        "Served a catalogue search",
        has_query=bool(q.strip()),
        source=source,
        returned=len(page.results),
        total=page.total,
    )
    return page


@router.get(
    "/skills/remote/sources",
    response_model=List[RemoteSourceStatus],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_remote_skill_sources() -> List[RemoteSourceStatus]:
    """Every allowlisted source and its last sync outcome — for an ops glance."""
    return await list_remote_sources()


@router.post(
    "/users/{user_id}/skills/remote/{source_id}/{skill_id}",
    response_model=SkillManifestEntry,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_internal_caller)],
)
async def add_remote_skill_to_user(
    user_id: str,
    source_id: str = Path(..., pattern=_ID_PATTERN),
    skill_id: str = Path(..., pattern=_ID_PATTERN),
) -> SkillManifestEntry:
    """Add a remote skill to the user's pool, downloading and verifying it if new."""
    try:
        return await add_remote_to_user(user_id, source_id, skill_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except SkillNameConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except RemoteSkillRefused as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"This skill failed verification ({exc}) and was not added.",
        ) from exc
    except RemoteSkillUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The skill's source could not be reached. Please try again later.",
        ) from exc
    except RemoteSkillsDisabled as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


# ------------------------------------------------------------------
# Per-User Skill Pool (manifest-driven)
# ------------------------------------------------------------------
# A user's pool lives in agent_runtime: custom skills they authored, remote
# skills they added, and legacy references into the deleted bundled catalogue.
# The per-(user, agent) PUT below only assigns a skill the user holds.
@router.get(
    "/users/{user_id}/skills",
    response_model=List[SkillManifestEntry],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_skill_pool(user_id: str) -> List[SkillManifestEntry]:
    """Return the user's manifest entries (no SKILL.md content, descriptions only)."""
    try:
        entries = await list_user_skills(user_id)
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
        return await get_user_skill_detail(user_id, skill_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post(
    "/users/{user_id}/skills/custom",
    response_model=SkillManifestEntry,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_internal_caller)],
)
async def create_user_custom_skill(user_id: str, payload: CustomSkillCreate) -> SkillManifestEntry:
    """Create a user-owned custom skill (multi-file folder + manifest entry).

    409 when the pool already holds the name; 422 on a
    structural validation failure (bad path, oversized file, disallowed type,
    invalid base64, or a missing SKILL.md).
    """
    try:
        return await add_custom_to_user(user_id, payload)
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
        await remove_from_user(user_id, skill_name)
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
        skills = await list_user_agent_skills(user_id=user_id, agent_slug=agent_slug)
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
        await assign_user_skill_to_agent(user_id, agent_slug, skill_name)
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
        await unassign_user_skill_from_agent(user_id, agent_slug, skill_name)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
