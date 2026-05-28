from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from observability import set_context

from core.database import ConversationTable, InferenceRunTable, UserTable, get_db
from schemas import (
    ConversationSummary,
    InferenceRunOut,
    InferenceRunStartPayload,
    InferenceRunStartResponse,
    MessageOut,
)
from core.auth_session import require_csrf_protection
from core.rate_limit import INFERENCE_RATE_LIMIT, inference_user_key, limiter
from utils import (
    validate_convId_full,
    validate_userId,
)
from utils.inference_runs import (
    build_run_event_payload,
    create_inference_run,
    inference_run_manager,
    observe_run_events,
    request_run_cancel,
)


router = APIRouter()


@router.post(
    "/runs/{user_id}/{conversation_id}",
    response_model=InferenceRunStartResponse,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit(INFERENCE_RATE_LIMIT, key_func=inference_user_key)
async def startInferenceRun(
    request: Request,
    user_id: str,
    conversation_id: str,
    payload: InferenceRunStartPayload,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> InferenceRunStartResponse:
    """Create a backend-owned inference run and start it independently of the observer connection."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    run, message = await create_inference_run(
        db=db,
        user_id=user_id,
        conversation=current_conv,
        parent_message_id=payload.parentMessageId,
        message_path=payload.messagePath,
        enabled_tools=payload.enabledTools,
    )

    await db.refresh(current_conv, attribute_names=["updated_at", "last_message_preview", "active_inference_run_id", "agent"])
    response = InferenceRunStartResponse(
        run=InferenceRunOut.model_validate(run),
        message=MessageOut.model_validate(message),
        summary=ConversationSummary.model_validate(current_conv),
    )
    inference_run_manager.launch(run.id)
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

