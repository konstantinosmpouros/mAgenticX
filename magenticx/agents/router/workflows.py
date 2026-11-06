"""Workflow endpoints: the node catalogue, validation, CRUD and the run stream.

Internal-caller only (``require_internal_caller``): the bridge proxies these
and owns the session, CSRF and rate-limit checks, exactly like the custom-agent
routes. Handlers are thin over ``utils.workflows``.

Route order matters: the fixed paths (``/workflows/catalog``,
``/workflows/validate``, ``/workflows/runs/stream``) are declared before the
``/workflows/{owner_user_id}`` family so they are never read as an owner id.

History (``…/{workflow_id}/versions``): the kept versions newest first, one
version's spec, and restore — which saves the old spec as a **new** version
(history is never rewritten) after validating it again.

An invalid spec on create/update/restore is a 422 whose ``detail`` is
``{message, errors: [{nodeId, path, message}]}``; another user's workflow is a
404, indistinguishable from a missing one.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from fastapi.responses import JSONResponse, StreamingResponse

from core.logging import get_logger, set_context
from core.security.internal_trust import require_internal_caller
from harness.checkpointer import has_checkpointer_initialized
from harness.workflows.catalog import node_catalog
from harness.workflows.runner import RunRefused
from harness.workflows.validator import ValidationIssue
from schema.workflows import (
    OWNER_ID_PATTERN,
    WORKFLOW_ID_PATTERN,
    WorkflowCatalog,
    WorkflowDetail,
    WorkflowIssue,
    WorkflowRunRequest,
    WorkflowSummary,
    WorkflowValidation,
    WorkflowVersionDetail,
    WorkflowVersionPage,
    WorkflowWrite,
)
from utils.workflows import (
    WorkflowNotFound,
    create_workflow,
    delete_workflow,
    get_workflow,
    get_workflow_version,
    list_workflow_versions,
    list_workflows,
    open_workflow_run,
    restore_workflow_version,
    update_workflow,
    validate_workflow,
)

logger = get_logger(__name__)

router = APIRouter(dependencies=[Depends(require_internal_caller)])

OwnerId = Path(pattern=OWNER_ID_PATTERN)
WorkflowId = Path(pattern=WORKFLOW_ID_PATTERN)
VersionNo = Path(ge=1, le=1_000_000)


def _issues(issues: list[ValidationIssue]) -> list[WorkflowIssue]:
    return [WorkflowIssue(node_id=i.node_id, path=i.path, message=i.message) for i in issues]


def _invalid(issues: list[ValidationIssue], message: str = "The workflow is invalid.") -> JSONResponse:
    """422 with every issue, so the builder can mark each node."""
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={
            "detail": {
                "message": message,
                "errors": [issue.as_dict() for issue in issues],
            }
        },
    )


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown workflow.")


@router.get("/workflows/catalog", response_model=WorkflowCatalog)
async def workflow_catalog() -> WorkflowCatalog:
    """Every node kind with its label, group, branches and config JSON Schema."""
    return WorkflowCatalog(kinds=node_catalog())


@router.post("/workflows/validate", response_model=WorkflowValidation)
async def validate_workflow_spec(payload: WorkflowWrite) -> WorkflowValidation:
    """Dry run: every problem with a spec, nothing written."""
    _, issues = await validate_workflow(payload.spec)
    return WorkflowValidation(ok=not issues, errors=_issues(issues))


@router.post("/workflows/runs/stream")
async def stream_workflow_run(req: WorkflowRunRequest):
    """Start (or resume) a run and stream it as AG-UI SSE.

    Refusals happen before the stream opens: 404 unknown workflow/version,
    409 thread already used / nothing to resume, 413/422 bad inputs, 503 when
    the checkpointer is not wired yet.
    """
    set_context(user_id=req.owner_user_id, thread_id=req.thread_id)
    if not has_checkpointer_initialized():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Checkpointer is not ready.")
    try:
        prepared = await open_workflow_run(req)
    except WorkflowNotFound as exc:
        raise _not_found() from exc
    except RunRefused as exc:
        return JSONResponse(status_code=exc.status, content={"detail": {"message": exc.message, "errors": exc.errors}})
    return StreamingResponse(prepared.stream(), media_type="text/event-stream")


@router.get("/workflows/{owner_user_id}", response_model=list[WorkflowSummary])
async def list_owner_workflows(
    owner_user_id: str = OwnerId,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
) -> list[WorkflowSummary]:
    """One page of the owner's workflows, most recently changed first."""
    return [WorkflowSummary(**row) for row in await list_workflows(owner_user_id, limit=limit, offset=offset)]


@router.post("/workflows/{owner_user_id}", response_model=WorkflowDetail, status_code=status.HTTP_201_CREATED)
async def create_owner_workflow(payload: WorkflowWrite, owner_user_id: str = OwnerId):
    """Validate and store a new workflow: draft + version 1."""
    detail, issues = await create_workflow(owner_user_id, payload.spec)
    if detail is None:
        return _invalid(issues)
    return WorkflowDetail(**detail)


@router.get("/workflows/{owner_user_id}/{workflow_id}", response_model=WorkflowDetail)
async def get_owner_workflow(owner_user_id: str = OwnerId, workflow_id: str = WorkflowId) -> WorkflowDetail:
    """One workflow: draft, newest version number and that version's spec."""
    try:
        return WorkflowDetail(**await get_workflow(owner_user_id, workflow_id))
    except WorkflowNotFound as exc:
        raise _not_found() from exc


@router.put("/workflows/{owner_user_id}/{workflow_id}", response_model=WorkflowDetail)
async def update_owner_workflow(payload: WorkflowWrite, owner_user_id: str = OwnerId, workflow_id: str = WorkflowId):
    """Validate and save; adds a version only when the spec changed."""
    try:
        detail, issues = await update_workflow(owner_user_id, workflow_id, payload.spec)
    except WorkflowNotFound as exc:
        raise _not_found() from exc
    if detail is None:
        return _invalid(issues)
    return WorkflowDetail(**detail)


@router.delete("/workflows/{owner_user_id}/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_owner_workflow(owner_user_id: str = OwnerId, workflow_id: str = WorkflowId) -> Response:
    """Delete a workflow with its versions and persisted state."""
    try:
        await delete_workflow(owner_user_id, workflow_id)
    except WorkflowNotFound as exc:
        raise _not_found() from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# -- history -----------------------------------------------------------------------


@router.get("/workflows/{owner_user_id}/{workflow_id}/versions", response_model=WorkflowVersionPage)
async def list_owner_workflow_versions(
    owner_user_id: str = OwnerId,
    workflow_id: str = WorkflowId,
    limit: int = Query(default=50, ge=1, le=100),
    before: int | None = Query(default=None, ge=1, le=1_000_000),
) -> WorkflowVersionPage:
    """The workflow's kept versions, newest first, each with a short summary."""
    try:
        page = await list_workflow_versions(owner_user_id, workflow_id, limit=limit, before=before)
    except WorkflowNotFound as exc:
        raise _not_found() from exc
    return WorkflowVersionPage(**page)


@router.get("/workflows/{owner_user_id}/{workflow_id}/versions/{version_no}", response_model=WorkflowVersionDetail)
async def get_owner_workflow_version(
    owner_user_id: str = OwnerId,
    workflow_id: str = WorkflowId,
    version_no: int = VersionNo,
) -> WorkflowVersionDetail:
    """One kept version with its whole spec (for a diff or a preview)."""
    try:
        return WorkflowVersionDetail(**await get_workflow_version(owner_user_id, workflow_id, version_no))
    except WorkflowNotFound as exc:
        raise _not_found() from exc


@router.post(
    "/workflows/{owner_user_id}/{workflow_id}/versions/{version_no}/restore",
    response_model=WorkflowDetail,
)
async def restore_owner_workflow_version(
    owner_user_id: str = OwnerId,
    workflow_id: str = WorkflowId,
    version_no: int = VersionNo,
):
    """Save version ``version_no``'s spec as the newest version.

    The answer is the workflow as after a save (``latest_version_no`` is the
    new version); 422 with every issue when the old spec no longer validates.
    """
    try:
        detail, issues = await restore_workflow_version(owner_user_id, workflow_id, version_no)
    except WorkflowNotFound as exc:
        raise _not_found() from exc
    if detail is None:
        return _invalid(issues, "This version no longer passes today's checks, so it can't be restored.")
    return WorkflowDetail(**detail)
