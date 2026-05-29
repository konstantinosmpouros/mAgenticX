from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from observability import set_context

from core.database import InferenceRunTable, UserTable, get_db
from schemas import (
    InferenceStartPayload,
    InferenceStartResponse,
    InferenceRunOut,
)
from core.auth_session import require_csrf_protection
from core.rate_limit import INFERENCE_RATE_LIMIT, inference_user_key, limiter
from utils import validate_userId
from utils.inference_runs import (
    build_run_event_payload,
    inference_run_manager,
    mark_run_launch_failed,
    observe_run_events,
    request_run_cancel,
)
from utils.inference_start import start_inference_flow


router = APIRouter()


@router.post(
    "/runs/{user_id}/start",
    response_model=InferenceStartResponse,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit(INFERENCE_RATE_LIMIT, key_func=inference_user_key)
async def startInferenceFlow(
    request: Request,
    user_id: str,
    payload: InferenceStartPayload,
    current_user: UserTable = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> InferenceStartResponse:
    """Persist the user-side action, create the AI placeholder, and launch a backend-owned run."""
    set_context(user_id=user_id, conversation_id=payload.conversationId)
    response = await start_inference_flow(db=db, user=current_user, payload=payload)
    try:
        inference_run_manager.launch(response.run.id)
    except Exception as exc:
        await mark_run_launch_failed(response.run.id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Inference run could not be launched.",
        ) from exc
    return response


@router.get("/runs/{user_id}", response_model=list[InferenceRunOut])
async def listInferenceRuns(
    user_id: str,
    status_filter: str | None = Query(default=None, alias="status"),
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> list[InferenceRunOut]:
    """List inference runs for hydration; `status=active` returns queued/running/cancelling runs."""
    stmt = select(InferenceRunTable).where(InferenceRunTable.user_id == user_id)
    if status_filter == "active":
        stmt = stmt.where(InferenceRunTable.status.in_(("queued", "running", "cancelling")))
    elif status_filter:
        stmt = stmt.where(InferenceRunTable.status == status_filter)
    stmt = stmt.order_by(InferenceRunTable.started_at.desc())
    result = await db.execute(stmt)
    return [InferenceRunOut.model_validate(run) for run in result.scalars().all()]


@router.get("/runs/{user_id}/{run_id}/stream")
async def observeInferenceRun(
    user_id: str,
    run_id: str,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(InferenceRunTable).where(InferenceRunTable.id == run_id, InferenceRunTable.user_id == user_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Inference run not found.")

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(observe_run_events(run_id), media_type="text/event-stream", headers=headers)


@router.post("/runs/{user_id}/{run_id}/cancel", response_model=InferenceRunOut)
async def cancelInferenceRun(
    user_id: str,
    run_id: str,
    current_user: UserTable = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> InferenceRunOut:
    result = await db.execute(select(InferenceRunTable).where(InferenceRunTable.id == run_id, InferenceRunTable.user_id == user_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Inference run not found.")
    run = await request_run_cancel(db, run)
    payload = await build_run_event_payload(db, run.id, "update")
    if payload:
        await inference_run_manager.publish(run.id, payload)
    return InferenceRunOut.model_validate(run)
