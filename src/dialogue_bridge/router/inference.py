import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from observability import get_logger, set_context

from core.database import ConversationTable, MessageTable, UserTable, get_db
from schemas import (
    InferenceStartPayload,
    InferenceStartResponse,
    InferenceRunOut,
)
from core.auth_session import authenticate_websocket_user, require_csrf_protection
from core.rate_limit import INFERENCE_RATE_LIMIT, inference_user_key, limiter
from utils import validate_userId
from utils.inference_runs import (
    build_run_event_payload,
    build_run_out_from_message,
    inference_run_manager,
    mark_run_launch_failed,
    observe_run_events,
    request_run_cancel,
    stream_run_events,
    SNAPSHOT_SEQ_SENTINEL,
)
from utils.inference_start import start_inference_flow


logger = get_logger(__name__)

# Close codes for the inference WebSocket endpoint. The 4xxx range is
# application-defined per RFC 6455; we mirror HTTP semantics for readability.
_WS_UNAUTHORIZED = 4401
_WS_FORBIDDEN = 4403
_WS_NOT_FOUND = 4404
_WS_BAD_REQUEST = 4400


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
    """List inference runs for hydration; ``status=active`` returns queued/running/cancelling runs.

    After the inference_runs-table collapse, an inference run is just an
    assistant message with a non-null ``streaming_status`` column. We filter
    by streaming_status and join through ``conversations`` to scope to the
    requesting user.
    """
    stmt = (
        select(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.is_not(None),
        )
    )
    if status_filter == "active":
        stmt = stmt.where(MessageTable.streaming_status.in_(("queued", "running", "cancelling")))
    elif status_filter:
        stmt = stmt.where(MessageTable.streaming_status == status_filter)
    stmt = stmt.order_by(MessageTable.streaming_started_at.desc())
    result = await db.execute(stmt)
    return [build_run_out_from_message(message, user_id=user_id) for message in result.scalars().all()]


@router.get("/runs/{user_id}/{run_id}/stream")
async def observeInferenceRun(
    user_id: str,
    run_id: str,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """Legacy SSE endpoint. Deprecated — clients should use the WebSocket
    endpoint at ``/runs/{user_id}/{run_id}/ws`` which supports reconnect with
    a ``since`` cursor. Kept here for one release cycle for compatibility.
    """
    # The "run id" is the assistant message id after the inference_runs collapse.
    # Authorize via the conversation owner.
    result = await db.execute(
        select(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            MessageTable.id == run_id,
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.is_not(None),
        )
    )
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Inference run not found.")

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(observe_run_events(run_id), media_type="text/event-stream", headers=headers)


@router.websocket("/runs/{user_id}/{run_id}/ws")
async def inference_run_websocket(
    websocket: WebSocket,
    user_id: str,
    run_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Stream inference events over WebSocket with reconnect-and-replay support.

    Protocol:
      - Client opens the WebSocket; the browser cookie carries the session.
      - First client frame: ``{"type": "subscribe", "since": "<seq>" | null}``
        where ``since`` is the last ``seq`` the client successfully processed.
        On a fresh connection the client sends ``null`` and gets the full
        backlog from the Redis stream (or the DB snapshot if the run is
        already terminal).
      - Server frames:
          ``{"type": "snapshot", "payload": <run-event-payload>}`` for runs
              already in a terminal state — exactly one frame, then close.
          ``{"type": "event", "seq": "<stream-id>", "payload": <run-event>}``
              for every live event. The client persists ``seq`` and resends it
              as ``since`` on reconnect.
          ``{"type": "terminal"}`` when the run reaches a terminal state.
              Server closes cleanly afterwards.
    """
    user = await authenticate_websocket_user(websocket.cookies, user_id, db)
    if user is None:
        await websocket.close(code=_WS_UNAUTHORIZED, reason="Authentication required")
        return

    result = await db.execute(
        select(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            MessageTable.id == run_id,
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.is_not(None),
        )
    )
    run = result.scalar_one_or_none()
    if not run:
        await websocket.close(code=_WS_NOT_FOUND, reason="Inference run not found")
        return

    await websocket.accept()
    set_context(user_id=user_id, conversation_id=run.conversation_id)

    # First client frame must be a subscribe.
    try:
        first_frame = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
    except asyncio.TimeoutError:
        await websocket.close(code=_WS_BAD_REQUEST, reason="No subscribe frame within 10s")
        return
    except WebSocketDisconnect:
        return
    except Exception:
        await websocket.close(code=_WS_BAD_REQUEST, reason="Invalid subscribe frame")
        return

    if not isinstance(first_frame, dict) or first_frame.get("type") != "subscribe":
        await websocket.close(code=_WS_BAD_REQUEST, reason="First frame must be subscribe")
        return

    since_raw = first_frame.get("since")
    since: str | None = since_raw if isinstance(since_raw, str) and since_raw else None

    logger.info(
        "ws_subscribe",
        "WebSocket subscriber attached",
        run_id=run_id,
        since=since or "",
        replay=bool(since),
    )

    try:
        async for seq, event in stream_run_events(run_id, since=since):
            if seq == SNAPSHOT_SEQ_SENTINEL:
                await websocket.send_json({"type": "snapshot", "payload": event})
            else:
                await websocket.send_json({"type": "event", "seq": seq, "payload": event})
        await websocket.send_json({"type": "terminal"})
    except WebSocketDisconnect:
        logger.info("ws_disconnect", "WebSocket subscriber disconnected", run_id=run_id)
        return
    except Exception:
        logger.error("ws_stream_failed", "WebSocket stream failed", exc_info=True, run_id=run_id)
        try:
            await websocket.close(code=1011, reason="Stream failed")
        except Exception:
            pass
        return
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@router.post("/runs/{user_id}/{run_id}/cancel", response_model=InferenceRunOut)
async def cancelInferenceRun(
    user_id: str,
    run_id: str,
    current_user: UserTable = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> InferenceRunOut:
    result = await db.execute(
        select(MessageTable)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            MessageTable.id == run_id,
            ConversationTable.user_id == user_id,
            MessageTable.streaming_status.is_not(None),
        )
    )
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Inference run not found.")
    run = await request_run_cancel(db, run)
    payload = await build_run_event_payload(db, run.id, "update")
    if payload:
        await inference_run_manager.publish(run.id, payload)
    return build_run_out_from_message(run, user_id=user_id)
