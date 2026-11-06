"""Workflow endpoints (plan 38): definitions (proxied) and runs (the bridge's own).

Two routers, mounted in ``main.py``:

* ``router`` at ``/v1/workflows`` — the node catalog, validation, a user's
  workflows (proxied to the agents service, each with the bridge's
  ``schedule``), pausing / resuming a workflow's schedule and, per workflow,
  starting a run, listing its runs and its version history (list, one
  version, restore);
* ``runs_router`` at ``/v1/workflow-runs`` — one run: its detail, its live
  event stream (SSE), resume and cancel.

Every ``{user_id}`` route runs ``validate_userId`` (the path user must be the
session's) and then acts as the **session's** user: upstream calls carry that id
as ``owner_user_id``, and every run lookup is scoped to it, so someone else's
workflow or run is a 404 — indistinguishable from one that does not exist.
Mutations require a CSRF token. Each route has a per-user rate limit, declared
after auth (+ CSRF) so a bucket only ever counts requests its user made.

The literal ``catalog`` and ``validate`` segments are declared before the
``{user_id}`` routes so they are never read as a user id. Path ids are
restricted to a safe alphabet before they reach an upstream URL.
"""
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection, require_current_user
from core.database import get_db
from core.logging import get_logger, set_context
from core.security.rate_limit import (
    workflow_builder_rate_limit,
    workflow_mutate_rate_limit,
    workflow_read_rate_limit,
    workflow_run_rate_limit,
)
from schema import (
    WorkflowOut,
    WorkflowRunDetail,
    WorkflowRunOut,
    WorkflowRunPage,
    WorkflowRunResume,
    WorkflowRunStart,
    WorkflowRunStarted,
    WorkflowScheduleOut,
    WorkflowValidation,
    WorkflowVersionDetailOut,
    WorkflowVersionPage,
    WorkflowWrite,
)
from utils import validate_userId
from utils.workflow_runs import (
    cancel_workflow_run,
    delete_runs_for_workflow,
    get_run_detail,
    get_run_for_user,
    launch_or_fail,
    list_runs,
    resume_workflow_run,
    run_out,
    start_workflow_run,
    stream_run_events,
)
from utils.workflow_schedules import (
    attach_schedules,
    delete_workflow_schedule,
    set_schedule_paused,
    sync_workflow_schedule,
)
from utils.workflows import (
    create_workflow,
    delete_workflow,
    get_workflow,
    get_workflow_catalog,
    get_workflow_tools,
    get_workflow_version,
    list_workflow_versions,
    list_workflows,
    restore_workflow_version,
    update_workflow,
    validate_workflow_spec,
)

router = APIRouter()
runs_router = APIRouter()
logger = get_logger(__name__)

#: Ids that reach an upstream URL or a query: a conservative alphabet.
_ID_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"
WorkflowId = Path(..., pattern=_ID_PATTERN)
RunId = Path(..., pattern=_ID_PATTERN)
VersionNo = Path(..., ge=1, le=1_000_000)

_RUN_NOT_FOUND = "Workflow run not found."


# ---------------------------------------------------------------------------
# Definitions
# ---------------------------------------------------------------------------
@router.get("/catalog", response_model=dict[str, Any] | list[Any], status_code=status.HTTP_200_OK)
async def workflow_catalog(
    _: AuthUser = Depends(require_current_user),
    __: None = Depends(workflow_builder_rate_limit),
) -> dict[str, Any] | list[Any]:
    """The node kinds the builder offers, with their JSON Schemas."""
    return await get_workflow_catalog()


@router.get("/tools", response_model=dict[str, Any], status_code=status.HTTP_200_OK)
async def workflow_tools(
    _: AuthUser = Depends(require_current_user),
    __: None = Depends(workflow_builder_rate_limit),
) -> dict[str, Any]:
    """The tools a Tool step may call, each with its input JSON Schema."""
    return await get_workflow_tools()


@router.post(
    "/validate",
    response_model=WorkflowValidation,
    status_code=status.HTTP_200_OK,
)
async def validate_workflow(
    payload: WorkflowWrite,
    _: AuthUser = Depends(require_current_user),
    __: None = Depends(require_csrf_protection),
    ___: None = Depends(workflow_builder_rate_limit),
) -> WorkflowValidation:
    """Dry run so the builder can show every problem before saving."""
    return await validate_workflow_spec(payload.spec)


@router.get("/{user_id}", response_model=list[WorkflowOut], status_code=status.HTTP_200_OK)
async def list_my_workflows(
    user_id: str,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(workflow_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowOut]:
    """The caller's workflows, each with its ``schedule`` (one batched query)."""
    set_context(user_id=user_id)
    return await attach_schedules(db, current_user.id, await list_workflows(current_user.id))


@router.post("/{user_id}", response_model=WorkflowOut, status_code=status.HTTP_201_CREATED)
async def create_my_workflow(
    user_id: str,
    payload: WorkflowWrite,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowOut:
    """Create upstream first; then materialise its schedule, if its start node has one."""
    set_context(user_id=user_id)
    workflow = await create_workflow(current_user.id, payload.spec)
    logger.info("workflow_created", "Workflow created", workflow_id=workflow.id)
    return await sync_workflow_schedule(db, current_user.id, workflow)


@router.get("/{user_id}/{workflow_id}", response_model=WorkflowOut, status_code=status.HTTP_200_OK)
async def get_my_workflow(
    user_id: str,
    workflow_id: str = WorkflowId,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(workflow_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowOut:
    set_context(user_id=user_id)
    workflow = await get_workflow(current_user.id, workflow_id)
    return (await attach_schedules(db, current_user.id, [workflow]))[0]


@router.put("/{user_id}/{workflow_id}", response_model=WorkflowOut, status_code=status.HTTP_200_OK)
async def update_my_workflow(
    user_id: str,
    payload: WorkflowWrite,
    workflow_id: str = WorkflowId,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowOut:
    """Save upstream first; then re-sync the schedule from the saved start node
    (a cadence change re-arms it, a manual or disabled trigger drops it)."""
    set_context(user_id=user_id)
    workflow = await update_workflow(current_user.id, workflow_id, payload.spec)
    logger.info("workflow_updated", "Workflow updated", workflow_id=workflow_id)
    return await sync_workflow_schedule(db, current_user.id, workflow)


@router.delete("/{user_id}/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_workflow(
    user_id: str,
    workflow_id: str = WorkflowId,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Delete the workflow upstream first, then its schedule and run history
    here: a failed upstream delete leaves both intact rather than orphan a
    workflow (a schedule left behind by a failure here is dropped by its next
    fire, which finds the workflow gone)."""
    set_context(user_id=user_id)
    await delete_workflow(current_user.id, workflow_id)
    await delete_workflow_schedule(db, current_user.id, workflow_id)
    removed = await delete_runs_for_workflow(db, current_user.id, workflow_id)
    logger.info("workflow_deleted", "Workflow deleted", workflow_id=workflow_id, runs_deleted=removed)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# A workflow's version history (proxied)
# ---------------------------------------------------------------------------
@router.get(
    "/{user_id}/{workflow_id}/versions",
    response_model=WorkflowVersionPage,
    status_code=status.HTTP_200_OK,
)
async def list_my_workflow_versions(
    user_id: str,
    workflow_id: str = WorkflowId,
    limit: int = Query(50, ge=1, le=100),
    before: int | None = Query(None, ge=1, le=1_000_000),
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(workflow_read_rate_limit),
) -> WorkflowVersionPage:
    """The workflow's kept versions, newest first; pass ``nextBefore`` back as
    ``?before=`` for older ones."""
    set_context(user_id=user_id)
    return await list_workflow_versions(current_user.id, workflow_id, limit=limit, before=before)


@router.get(
    "/{user_id}/{workflow_id}/versions/{version_no}",
    response_model=WorkflowVersionDetailOut,
    status_code=status.HTTP_200_OK,
)
async def get_my_workflow_version(
    user_id: str,
    workflow_id: str = WorkflowId,
    version_no: int = VersionNo,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(workflow_read_rate_limit),
) -> WorkflowVersionDetailOut:
    """One kept version with its whole spec (the History panel's diff and preview)."""
    set_context(user_id=user_id)
    return await get_workflow_version(current_user.id, workflow_id, version_no)


@router.post(
    "/{user_id}/{workflow_id}/versions/{version_no}/restore",
    response_model=WorkflowOut,
    status_code=status.HTTP_200_OK,
)
async def restore_my_workflow_version(
    user_id: str,
    workflow_id: str = WorkflowId,
    version_no: int = VersionNo,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowOut:
    """Save an old version's spec as a new version — history is never
    rewritten — then re-sync the schedule from it, as after any save (the old
    version may have a different start node). 422 with the issues when the old
    version no longer passes today's checks."""
    set_context(user_id=user_id)
    workflow = await restore_workflow_version(current_user.id, workflow_id, version_no)
    logger.info(
        "workflow_version_restored", "Workflow version restored",
        workflow_id=workflow_id, restored_from=version_no, latest_version_no=workflow.latestVersionNo,
    )
    return await sync_workflow_schedule(db, current_user.id, workflow)


# ---------------------------------------------------------------------------
# A workflow's schedule (edited in the builder; only paused/resumed here)
# ---------------------------------------------------------------------------
@router.post(
    "/{user_id}/{workflow_id}/schedule/pause",
    response_model=WorkflowScheduleOut,
    status_code=status.HTTP_200_OK,
)
async def pause_my_workflow_schedule(
    user_id: str,
    workflow_id: str = WorkflowId,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowScheduleOut:
    """Stop the schedule firing until resumed; 404 when the workflow has none.
    A re-save of the workflow keeps it paused."""
    set_context(user_id=user_id)
    return await set_schedule_paused(db, current_user.id, workflow_id, paused=True)


@router.post(
    "/{user_id}/{workflow_id}/schedule/resume",
    response_model=WorkflowScheduleOut,
    status_code=status.HTTP_200_OK,
)
async def resume_my_workflow_schedule(
    user_id: str,
    workflow_id: str = WorkflowId,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowScheduleOut:
    """Fire on schedule again from the next future slot (missed ones are
    skipped); a one-off whose moment has passed comes back ``finished``."""
    set_context(user_id=user_id)
    return await set_schedule_paused(db, current_user.id, workflow_id, paused=False)


# ---------------------------------------------------------------------------
# Runs of one workflow
# ---------------------------------------------------------------------------
@router.post(
    "/{user_id}/{workflow_id}/runs",
    response_model=WorkflowRunStarted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_my_workflow_run(
    user_id: str,
    payload: WorkflowRunStart,
    workflow_id: str = WorkflowId,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_run_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowRunStarted:
    """Start a run in the background; follow it on its event stream.

    409 while the workflow already has a live (queued, running or waiting) run;
    429 past the per-user cap on runs in progress.
    """
    set_context(user_id=user_id)
    run = await start_workflow_run(db, current_user.id, workflow_id, payload.inputs)
    await launch_or_fail(run.id)
    return WorkflowRunStarted(runId=run.id)


@router.get("/{user_id}/{workflow_id}/runs", response_model=WorkflowRunPage, status_code=status.HTTP_200_OK)
async def list_my_workflow_runs(
    user_id: str,
    workflow_id: str = WorkflowId,
    cursor: str | None = Query(None, max_length=512),
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(workflow_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowRunPage:
    """The workflow's runs, newest first; pass ``nextCursor`` back for more."""
    set_context(user_id=user_id)
    return await list_runs(db, current_user.id, workflow_id, cursor)


# ---------------------------------------------------------------------------
# One run
# ---------------------------------------------------------------------------
async def _owned_run(db: AsyncSession, user: AuthUser, run_id: str):
    run = await get_run_for_user(db, user.id, run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_RUN_NOT_FOUND)
    return run


@runs_router.get("/{user_id}/{run_id}", response_model=WorkflowRunDetail, status_code=status.HTTP_200_OK)
async def get_my_workflow_run(
    user_id: str,
    run_id: str = RunId,
    after_seq: int = Query(0, ge=0),
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(workflow_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowRunDetail:
    """The run, its inputs and its events (oldest first, paged past 5000)."""
    set_context(user_id=user_id)
    run = await _owned_run(db, current_user, run_id)
    return await get_run_detail(db, run, after_seq)


@runs_router.get("/{user_id}/{run_id}/events/stream", status_code=status.HTTP_200_OK)
async def stream_my_workflow_run(
    user_id: str,
    run_id: str = RunId,
    after_seq: int | None = Query(None, ge=0),
    last_event_id: str | None = Header(None, alias="Last-Event-ID", max_length=20),
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(workflow_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Server-sent events: the run's status, its events after ``after_seq``
    (or the ``Last-Event-ID`` a reconnecting ``EventSource`` sends), then the
    live tail until the run ends or pauses for an approval.

    Frames: ``{"type":"status","run":{…}}`` and
    ``{"type":"event","event":{seq,type,nodeId,executionId,parentExecutionId,payload,createdAt}}``
    (with ``id: <seq>``); ``: keep-alive`` comments while idle.
    """
    set_context(user_id=user_id)
    await _owned_run(db, current_user, run_id)
    # Nothing else is read on this session: give its connection back before a
    # stream that may stay open for minutes.
    await db.close()
    start = after_seq
    if start is None:
        start = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0
    return StreamingResponse(
        stream_run_events(run_id, start),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@runs_router.post("/{user_id}/{run_id}/resume", response_model=WorkflowRunOut, status_code=status.HTTP_202_ACCEPTED)
async def resume_my_workflow_run(
    user_id: str,
    payload: WorkflowRunResume,
    run_id: str = RunId,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_run_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowRunOut:
    """Approve or reject the approval a ``waiting`` run is paused on (409 when
    it is not waiting); the run streams again on its event stream."""
    set_context(user_id=user_id)
    run = await _owned_run(db, current_user, run_id)
    run = await resume_workflow_run(db, run, payload.decision, payload.comment)
    resume = {"decision": payload.decision, **({"comment": payload.comment} if payload.comment else {})}
    await launch_or_fail(run.id, resume)
    return run_out(run)


@runs_router.post("/{user_id}/{run_id}/cancel", response_model=WorkflowRunOut, status_code=status.HTTP_200_OK)
async def cancel_my_workflow_run(
    user_id: str,
    run_id: str = RunId,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    __: None = Depends(workflow_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> WorkflowRunOut:
    """Cancel a queued, running or waiting run; a finished run is returned as is."""
    set_context(user_id=user_id)
    run = await _owned_run(db, current_user, run_id)
    run = await cancel_workflow_run(run)
    logger.info("workflow_run_cancel_requested", "Workflow run cancel requested", run_id=run_id, status=run.status)
    return run_out(run)
