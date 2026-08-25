"""User-authored agent endpoints (the agent builder's backend).

Thin handlers over ``runtime.abstractions.user_agents``: list, read, validate,
write and delete the agent definitions in one user's workspace. Internal-caller
only — the bridge proxies these and owns the session/CSRF checks, exactly like
the per-user skill endpoints.

The dry-run ``validate`` route exists so the builder UI can surface every problem
with a definition before anything is written; ``PUT`` re-validates regardless,
because the UI is never the authority.
"""
from fastapi import APIRouter, Depends, HTTPException, status

from core.security.internal_trust import require_internal_caller
from core.settings import settings
from core.logging import get_logger
from runtime.abstractions.user_agents import (
    delete_user_agent,
    get_user_agent,
    list_user_agents,
    validate_write,
    write_user_agent,
)
from runtime.skill_registry.user_registry import list_user_skill_names
from schema import (
    CustomAgentValidation,
    CustomAgentWrite,
    UserAgentDetail,
    UserAgentSummary,
)
from utils.agents import AGENT_REGISTRY

logger = get_logger(__name__)

router = APIRouter()


def _reserved_slugs() -> frozenset[str]:
    """Slugs a user may not take — every built-in agent's.

    Keeps the per-user tools endpoint unambiguous (it resolves platform-first)
    and stops a user agent from being mistaken for a built-in in any UI.
    """
    return frozenset(AGENT_REGISTRY.keys())


def _known_skills(user_id: str) -> frozenset[str]:
    return frozenset(list_user_skill_names(user_id))


def _validate(user_id: str, payload: CustomAgentWrite, existing_slug: str | None = None):
    return validate_write(
        user_id,
        payload.spec,
        payload.files,
        reserved_slugs=_reserved_slugs(),
        known_skills=_known_skills(user_id),
        existing_slug=existing_slug,
    )


@router.get(
    "/users/{user_id}/custom-agents",
    response_model=list[UserAgentSummary],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def list_custom_agents(user_id: str) -> list[UserAgentSummary]:
    """Every agent this user has authored."""
    agents = list_user_agents(user_id)
    logger.info("user_agents_listed", "Listed user-authored agents", count=len(agents))
    return agents


@router.get(
    "/users/{user_id}/custom-agents/{agent_slug}",
    response_model=UserAgentDetail,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_custom_agent(user_id: str, agent_slug: str) -> UserAgentDetail:
    """One agent's full definition (spec + prompt files), for editing."""
    detail = get_user_agent(user_id, agent_slug)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")
    return detail


@router.post(
    "/users/{user_id}/custom-agents/validate",
    response_model=CustomAgentValidation,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def validate_custom_agent(user_id: str, payload: CustomAgentWrite) -> CustomAgentValidation:
    """Dry run: report every problem with a definition and write nothing."""
    _, errors = _validate(user_id, payload)
    return CustomAgentValidation(valid=not errors, errors=errors)


@router.post(
    "/users/{user_id}/custom-agents",
    response_model=UserAgentSummary,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_internal_caller)],
)
async def create_custom_agent(user_id: str, payload: CustomAgentWrite) -> UserAgentSummary:
    """Create an agent. 409 if the slug is already taken by this user, 422 on an
    invalid definition, 429 when the per-user cap is reached."""
    spec, errors = _validate(user_id, payload)
    if errors or spec is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="; ".join(errors)
        )

    existing = list_user_agents(user_id)
    if any(item.slug == spec.slug for item in existing):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You already have an agent named {spec.slug!r}.",
        )
    cap = settings.registry.max_agents_per_user
    if len(existing) >= cap:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"You have reached the limit of {cap} agents.",
        )

    summary = write_user_agent(user_id, spec, payload.files)
    logger.info("user_agent_created", "Created a user-authored agent", agent_slug=summary.slug)
    return summary


@router.put(
    "/users/{user_id}/custom-agents/{agent_slug}",
    response_model=UserAgentSummary,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def update_custom_agent(
    user_id: str, agent_slug: str, payload: CustomAgentWrite
) -> UserAgentSummary:
    """Replace an existing definition. The slug is immutable — a rename is a
    create plus a delete, so the folder name and the spec can never disagree."""
    if get_user_agent(user_id, agent_slug) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")

    spec, errors = _validate(user_id, payload, existing_slug=agent_slug)
    if errors or spec is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="; ".join(errors)
        )

    summary = write_user_agent(user_id, spec, payload.files)
    logger.info("user_agent_updated", "Updated a user-authored agent", agent_slug=summary.slug)
    return summary


@router.delete(
    "/users/{user_id}/custom-agents/{agent_slug}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def delete_custom_agent(user_id: str, agent_slug: str) -> None:
    """Remove a definition. Idempotent, and it removes only the definition — the
    agent's memory, enabled skills and conversation files are left untouched."""
    delete_user_agent(user_id, agent_slug)
