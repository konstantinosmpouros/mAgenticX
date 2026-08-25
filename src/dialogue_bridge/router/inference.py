import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession
from core.logging import get_logger, set_context

from core.database import SessionLocal, get_db
from core.settings import settings
from schemas import (
    InferenceStartPayload,
    InferenceStartResponse,
    InferenceRunOut,
    InferenceRunResumeIn,
)
from core.auth.session import AuthUser, authenticate_websocket_user, require_csrf_protection
from core.security.rate_limit import allow_ws_connect, inference_rate_limit
from utils import validate_userId
from utils.inference_runs import (
    build_run_event_payload,
    build_run_out_from_message,
    get_active_run_for_user,
    inference_run_manager,
    list_runs_for_user,
    mark_run_launch_failed,
    request_run_cancel,
    request_run_resume,
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
_WS_RATE_LIMITED = 4429


router = APIRouter()


@router.post(
    "/runs/{user_id}/start",
    response_model=InferenceStartResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(inference_rate_limit)],  # per-user run-start ceiling
)
async def startInferenceFlow(
    user_id: str,
    payload: InferenceStartPayload,
    current_user: AuthUser = Depends(validate_userId),
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
    current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> list[InferenceRunOut]:
    """List inference runs for hydration; ``status=active`` returns queued/running/cancelling runs.

    After the inference_runs-table collapse, an inference run is just an
    assistant message with a non-null ``streaming_status`` column. We filter
    by streaming_status and join through ``conversations`` to scope to the
    requesting user.
    """
    runs = await list_runs_for_user(db, user_id, status_filter)
    return [build_run_out_from_message(message, user_id=user_id) for message in runs]


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
      - Server frames:
          ``{"type": "snapshot", "payload": <run-event-payload>}`` — sent once
              on a fresh subscribe (``since`` null): for terminal runs the
              DB-built final state; for in-flight runs a synthesized live
              snapshot whose ``run.rawEvents`` carries the full coalesced
              event log so far. The client folds it, then applies deltas.
          ``{"type": "event", "seq": "<stream-id>", "payload": <frame>}``
              for every live frame; ``frame.type == "events"`` carries the
              new seq-stamped AG-UI events of one upstream chunk plus run
              meta. The client persists ``seq`` and resends it as ``since``
              on reconnect, and skips events whose ``seq`` it already folded.
          ``{"type": "terminal", "payload": <run-event-payload> | null}``
              when the run reaches a terminal state. The payload is the
              DB-built final state — the client applies it before closing,
              so the run flips to its real status even when the terminal
              stream entry was lost on this socket. Server closes cleanly
              afterwards.
    """
    user = await authenticate_websocket_user(websocket.cookies, user_id)
    if user is None:
        await websocket.close(code=_WS_UNAUTHORIZED, reason="Authentication required")
        return

    # Connect-rate guard: the SDK's rate-limit middleware is HTTP-only, so the
    # socket route meters its own handshakes (per verified user, fail-open).
    if not await allow_ws_connect(websocket, user_id):
        await websocket.close(code=_WS_RATE_LIMITED, reason="Too many connections; retry shortly")
        return

    run = await get_active_run_for_user(db, user_id, run_id)
    if not run:
        await websocket.close(code=_WS_NOT_FOUND, reason="Inference run not found")
        return

    await websocket.accept()
    set_context(user_id=user_id, conversation_id=run.conversation_id)

    # First client frame must be a subscribe.
    try:
        first_frame = await asyncio.wait_for(
            websocket.receive_json(), timeout=settings.inference.ws_subscribe_timeout_seconds
        )
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
        # The terminal frame carries the authoritative final state: if the
        # terminal stream entry was lost on this socket (send raced the close,
        # reconnect gap), the client still flips the run to its real status.
        terminal_payload = None
        try:
            async with SessionLocal() as terminal_db:
                terminal_payload = await build_run_event_payload(terminal_db, run_id, "terminal")
        except Exception:
            logger.warning(
                "ws_terminal_payload_failed",
                "Failed to build terminal payload; sending bare terminal frame",
                exc_info=True,
                run_id=run_id,
            )
        await websocket.send_json({"type": "terminal", "payload": terminal_payload})
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
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> InferenceRunOut:
    run = await get_active_run_for_user(db, user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inference run not found.")
    run = await request_run_cancel(db, run)
    await inference_run_manager.publish_run_status(run, user_id=user_id)
    return build_run_out_from_message(run, user_id=user_id)


@router.post("/runs/{user_id}/{run_id}/resume", response_model=InferenceRunOut)
async def resumeInferenceRun(
    user_id: str,
    run_id: str,
    payload: InferenceRunResumeIn,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> InferenceRunOut:
    """Send a HITL approve/reject decision to a paused inference run.

    Looks up the AI message, validates the requesting user owns the
    conversation, and signals the manager's per-run resume event with the
    payload. The manager's ``_run`` task races this event against the cancel
    event; on resume it POSTs to the agents service ``/agents/{slug}/resume``
    endpoint, which feeds a ``Command(resume=...)`` into the saved LangGraph
    checkpoint. Resulting events flow through the same Redis stream + WS
    observers as the original run.
    """
    run = await get_active_run_for_user(db, user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inference run not found.")

    resume_payload = {
        "decision": payload.decision,
        "reason": payload.reason,
        "value": payload.value,
        "interrupt_id": payload.interruptId,
        "decisions": [d.model_dump() for d in payload.decisions] if payload.decisions else None,
    }
    accepted = await request_run_resume(run, resume_payload)
    if not accepted:
        raise HTTPException(
            status_code=409,
            detail="Run is not paused on a HITL interrupt.",
        )

    logger.info(
        "inference_run_resume_received",
        "Inference run resume signalled from bridge",
        run_id=run.id,
        decision=payload.decision,
    )
    return build_run_out_from_message(run, user_id=user_id)
