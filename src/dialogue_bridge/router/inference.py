import asyncio
import json
import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from observability import StreamMetrics, elapsed_ms, get_context, get_logger, iter_tracked_stream, log_stream_outcome, set_context

from core.database import ConversationTable, InferenceRunTable, UserTable, get_db
from core.tls import get_httpx_verify
from schemas import (
    ConversationSummary,
    InferenceRunOut,
    InferenceRunStartPayload,
    InferenceRunStartResponse,
    InferenceStreamPayload,
    MessageOut,
)
from core.auth_session import require_csrf_protection
from core.proxy import internal_service_headers
from core.rate_limit import INFERENCE_RATE_LIMIT, inference_user_key, limiter
from utils import (
    build_agent_stream_url,
    get_agent_by_id,
    prepare_inference_history,
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

logger = get_logger(__name__)


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


@router.post("/stream/{user_id}/{conversation_id}")
async def startInferenceStream(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
    _: None = Depends(require_csrf_protection),
    payload: InferenceStreamPayload | None = None,
):
    """
    Proxy an inference stream from the selected agent to the UI as SSE.
    - Validates the agent is available for the conversation and builds the agent endpoint.
    - Validates and builds the message history for the requested branch (if provided).
    - Builds chat history for the agent as List[Dict[str, str]] (role/content only).
    - POSTs to the agents service stream endpoint and forwards bytes as-is.
    Image attachments are forwarded to the agent as base64 data URLs.
    """
    set_context(user_id=user_id, conversation_id=conversation_id)
    # Resolve agent stream endpoint
    agent = await get_agent_by_id(current_conv.agent_id)
    agent_url = build_agent_stream_url(agent)
    agent_slug = getattr(agent, "slug", None)
    request_logger = logger.bind(agent_id=current_conv.agent_id, agent_slug=agent_slug)
    
    # Build chat history for the requested branch (fallback = whole conversation)
    message_ids = payload.messagePath if payload and payload.messagePath else None
    enabled_tools = payload.enabledTools if payload else None
    history_messages, history = prepare_inference_history(
        logger=request_logger,
        messages=current_conv.messages,
        message_ids=message_ids,
        enabled_tools_count=len(enabled_tools or []),
    )
    
    # Log inference start with history and tools metadata
    request_logger.info("inference_stream_started", "Inference stream started", history_messages=len(history_messages), enabled_tools=len(enabled_tools or []))
    
    # Capture request_id from context before entering the generator so it's
    # available even if the context has been cleared by the time chunks flow.
    request_context = get_context()
    request_id = request_context.get("request_id")

    # Stream inference from agent service to client
    async def event_stream():
        metrics = StreamMetrics(event_separator=b"\n\n", started_at=time.perf_counter())
        timeout = httpx.Timeout(connect=30.0, read=180.0, write=180.0, pool=30.0)
        try:
            async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
                try:
                    tools_config = (
                        [{"tool_name": item.tool_name, "server_id": item.server_id} for item in enabled_tools]
                        if enabled_tools
                        else None
                    )
                    req_payload = {
                        "messages": history,
                        "config": {
                            "run_config": {
                                "configurable": {
                                    "thread_id": str(conversation_id),
                                }
                            },
                            "context": {
                                "user_id": str(user_id),
                                "conversation_id": str(conversation_id),
                            },
                            "tools": tools_config,
                        },
                    }
                    upstream_headers = internal_service_headers(request_id)
                    upstream_headers["Accept"] = "text/event-stream"
                    upstream_started_at = time.perf_counter()
                    async with client.stream(
                        "POST",
                        agent_url,
                        json=req_payload,
                        headers=upstream_headers,
                    ) as r:
                        r.raise_for_status()
                        upstream_connect_latency_ms = elapsed_ms(upstream_started_at)
                        request_logger.info(
                            "inference_upstream_connected",
                            "Inference upstream stream connected",
                            context=request_context,
                            upstream_service="agents",
                            upstream_status_code=r.status_code,
                            upstream_connect_latency_ms=upstream_connect_latency_ms,
                        )
                        async for chunk in iter_tracked_stream(r.aiter_bytes(), metrics):
                            yield chunk
                    log_stream_outcome(
                        request_logger,
                        logging.INFO,
                        "inference_stream_completed",
                        "Inference stream completed",
                        metrics=metrics,
                        completed=True,
                        context=request_context,
                        upstream_service="agents",
                    )
                except asyncio.CancelledError:
                    log_stream_outcome(
                        request_logger,
                        logging.INFO,
                        "inference_stream_cancelled",
                        "Inference stream cancelled by client",
                        metrics=metrics,
                        context=request_context,
                    )
                    return
        except asyncio.CancelledError:
            log_stream_outcome(
                request_logger,
                logging.INFO,
                "inference_stream_cancelled",
                "Inference request context cancelled",
                metrics=metrics,
                context=request_context,
            )
            return
        except httpx.HTTPError as e:
            request_logger.error(
                "inference_upstream_error",
                "Inference upstream error",
                exc_info=True,
                context=request_context,
                upstream_service="agents",
                error=str(e),
            )
            err = {
                "type": "RUN_ERROR",
                "message": "The assistant service is temporarily unavailable. Please try again shortly.",
            }
            data = "data: " + json.dumps(err, ensure_ascii=False) + "\n\n"
            yield data.encode("utf-8")

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)
