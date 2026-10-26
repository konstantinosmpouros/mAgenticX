"""User-authored agent endpoints (the agent builder's backend).

Thin handlers over ``harness.abstractions.user_agents``: list, read, validate,
write, delete, import and export the agent definitions of one user.
Internal-caller only — the bridge proxies these and owns the session/CSRF
checks, exactly like the per-user skill endpoints.

The dry-run ``validate`` route exists so the builder UI can surface every problem
with a definition before anything is written; ``POST``/``PUT`` re-validate
regardless, because the UI is never the authority. Problems come back as issues
pinned to a path in the spec; an invalid write is a 422 whose ``detail`` is
``{message, errors, issues}`` (409 and 429 keep a string ``detail``).
"""
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse

from core.logging import get_logger
from core.security.internal_trust import require_internal_caller
from core.settings import settings
from harness.abstractions.user_agents import (
    AgentDefinitionExistsError,
    delete_user_agent,
    errors_of,
    export_user_agent,
    get_user_agent,
    list_user_agents,
    parse_agent_yaml,
    validate_definition,
    write_user_agent,
)
from harness.skill_registry.user_registry import list_user_skill_names
from schema import (
    AgentIssue,
    CustomAgentImport,
    CustomAgentImportResult,
    CustomAgentValidation,
    CustomAgentWrite,
    UserAgentDetail,
    UserAgentSummary,
)
from utils import known_mcp_tool_keys
from utils.agents import AGENT_REGISTRY

logger = get_logger(__name__)

router = APIRouter()


def _reserved_slugs() -> frozenset[str]:
    """Slugs a user may not take — every built-in agent's.

    Keeps the per-user tools endpoint unambiguous (it resolves platform-first)
    and stops a user agent from being mistaken for a built-in in any UI.
    """
    return frozenset(AGENT_REGISTRY.keys())


async def _known_skills(user_id: str) -> frozenset[str]:
    """The names this user may reference in a spec's ``skills:``.

    Async because the pool is rows in ``agent_runtime`` rather than a manifest
    on disk. Awaiting it is not optional: ``frozenset()`` over an un-awaited
    coroutine raises ``TypeError``, which the handler turns into a 500 — so a
    missed ``await`` here breaks every create and update rather than degrading.
    """
    return frozenset(await list_user_skill_names(user_id))


async def _validate(
    user_id: str, spec: dict, files: list, existing_slug: str | None = None
):
    return validate_definition(
        user_id,
        spec,
        files,
        reserved_slugs=_reserved_slugs(),
        known_skills=await _known_skills(user_id),
        existing_slug=existing_slug,
        known_mcp_tools=await known_mcp_tool_keys(),
        mcp_enabled=settings.mcp.enabled,
    )


def _result(issues: list[AgentIssue]) -> CustomAgentValidation:
    errors = errors_of(issues)
    return CustomAgentValidation(valid=not errors, errors=errors, issues=issues)


def _invalid(issues: list[AgentIssue]) -> JSONResponse:
    """422 with every issue, so the builder can mark each field.

    Returned rather than raised: the service's ``HTTPException`` handler keeps
    only string details, and this one is structured on purpose.
    """
    errors = errors_of(issues)
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={
            "detail": {
                "message": "; ".join(errors),
                "errors": errors,
                "issues": [issue.model_dump() for issue in issues],
            }
        },
    )


@router.get(
    "/users/{user_id}/custom-agents",
    response_model=list[UserAgentSummary],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def list_custom_agents(user_id: str) -> list[UserAgentSummary]:
    """Every agent this user has authored."""
    agents = await list_user_agents(user_id)
    logger.info("user_agents_listed", "Listed user-authored agents", count=len(agents))
    return agents


@router.post(
    "/users/{user_id}/custom-agents/validate",
    response_model=CustomAgentValidation,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def validate_custom_agent(user_id: str, payload: CustomAgentWrite) -> CustomAgentValidation:
    """Dry run: report every problem with a definition and write nothing."""
    _, issues = await _validate(user_id, payload.spec, payload.files)
    return _result(issues)


@router.post(
    "/users/{user_id}/custom-agents/import",
    response_model=CustomAgentImportResult,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def import_custom_agent(user_id: str, payload: CustomAgentImport) -> CustomAgentImportResult:
    """Read an uploaded ``agent.yaml`` (and its files) into a definition and check
    it — never saves. The spec comes back whenever the YAML parsed, valid or
    not, so the builder can open it in the form to fix."""
    spec, files, issues = parse_agent_yaml(payload.yaml, payload.files)
    if spec is not None:
        _, checked = await _validate(user_id, spec, files)
        issues = [*issues, *checked]
    errors = errors_of(issues)
    logger.info(
        "user_agent_import_checked",
        "Checked an imported agent definition",
        valid=not errors,
        issue_count=len(issues),
    )
    return CustomAgentImportResult(
        valid=spec is not None and not errors, errors=errors, issues=issues, spec=spec, files=files
    )


@router.get(
    "/users/{user_id}/custom-agents/{agent_slug}",
    response_model=UserAgentDetail,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_custom_agent(user_id: str, agent_slug: str) -> UserAgentDetail:
    """One agent's full definition (spec + prompt files), for editing."""
    detail = await get_user_agent(user_id, agent_slug)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")
    return detail


@router.get(
    "/users/{user_id}/custom-agents/{agent_slug}/export",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def export_custom_agent(user_id: str, agent_slug: str) -> Response:
    """The agent as a ``.zip`` — ``agent.yaml`` and its files — that imports back."""
    archive = await export_user_agent(user_id, agent_slug)
    if archive is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")
    return Response(
        content=archive,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{agent_slug}.zip"'},
    )


@router.post(
    "/users/{user_id}/custom-agents",
    response_model=UserAgentSummary,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_internal_caller)],
)
async def create_custom_agent(user_id: str, payload: CustomAgentWrite) -> UserAgentSummary | JSONResponse:
    """Create an agent. 409 if the slug is already taken by this user, 422 on an
    invalid definition, 429 when the per-user cap is reached."""
    spec, issues = await _validate(user_id, payload.spec, payload.files)
    if spec is None:
        return _invalid(issues)

    taken = f"You already have an agent named {spec.slug!r}."
    existing = await list_user_agents(user_id)
    if any(item.slug == spec.slug for item in existing):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=taken)
    cap = settings.registry.max_agents_per_user
    if len(existing) >= cap:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"You have reached the limit of {cap} agents.",
        )

    try:
        summary = await write_user_agent(user_id, spec, payload.files, create=True)
    except AgentDefinitionExistsError:
        # Another create of the same slug landed between the check and the write.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=taken) from None
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
) -> UserAgentSummary | JSONResponse:
    """Replace an existing definition. The slug is immutable — a rename is a
    create plus a delete, so the stored key and the spec can never disagree."""
    if await get_user_agent(user_id, agent_slug) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent.")

    spec, issues = await _validate(user_id, payload.spec, payload.files, existing_slug=agent_slug)
    if spec is None:
        return _invalid(issues)

    summary = await write_user_agent(user_id, spec, payload.files)
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
    await delete_user_agent(user_id, agent_slug)
