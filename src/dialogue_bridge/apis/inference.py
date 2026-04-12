import asyncio
import json
import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from observability import StreamMetrics, elapsed_ms, get_context, iter_tracked_stream, log_event, log_stream_outcome, set_context

from database import ConversationTable, UserTable
from database.schemas import InferenceStreamPayload
from vault_auth.session_auth import require_csrf_protection
from utils import (
    build_agent_stream_url,
    get_agent_by_id,
    prepare_inference_history,
    validate_convId_full,
    validate_userId,
)


router = APIRouter(
    prefix="/users/{user_id}/conversations/{conversation_id}",
    tags=["Inference"],
)

logger = logging.getLogger(__name__)


@router.post("/inference/stream")
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
    
    # Build chat history for the requested branch (fallback = whole conversation)
    message_ids = payload.messagePath if payload and payload.messagePath else None
    enabled_tools = payload.enabledTools if payload else None
    history_messages, history = prepare_inference_history(
        logger=logger,
        messages=current_conv.messages,
        message_ids=message_ids,
        enabled_tools_count=len(enabled_tools or []),
    )
    
    # Log inference start with history and tools metadata
    log_event(
        logger,
        logging.INFO,
        "inference_stream_started",
        "Inference stream started",
        agent_id=current_conv.agent_id,
        history_messages=len(history_messages),
        enabled_tools=len(enabled_tools or []),
    )
    
    # Capture request_id from context before entering the generator so it's
    # available even if the context has been cleared by the time chunks flow.
    request_context = get_context()
    request_id = request_context.get("request_id")

    # Stream inference from agent service to client
    async def event_stream():
        metrics = StreamMetrics(event_separator=b"\n\n", started_at=time.perf_counter())
        timeout = httpx.Timeout(connect=30.0, read=180.0, write=180.0, pool=30.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
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
                    upstream_headers = {"Accept": "text/event-stream"}
                    if request_id:
                        upstream_headers["X-Request-ID"] = request_id
                    upstream_started_at = time.perf_counter()
                    async with client.stream(
                        "POST",
                        agent_url,
                        json=req_payload,
                        headers=upstream_headers,
                    ) as r:
                        r.raise_for_status()
                        upstream_connect_latency_ms = elapsed_ms(upstream_started_at)
                        log_event(
                            logger,
                            logging.INFO,
                            "inference_upstream_connected",
                            "Inference upstream stream connected",
                            context=request_context,
                            upstream_service="agents",
                            agent_id=current_conv.agent_id,
                            agent_slug=agent_slug,
                            upstream_status_code=r.status_code,
                            upstream_connect_latency_ms=upstream_connect_latency_ms,
                        )
                        async for chunk in iter_tracked_stream(r.aiter_bytes(), metrics):
                            yield chunk
                    log_stream_outcome(
                        logger,
                        logging.INFO,
                        "inference_stream_completed",
                        "Inference stream completed",
                        metrics=metrics,
                        completed=True,
                        context=request_context,
                        upstream_service="agents",
                        agent_id=current_conv.agent_id,
                        agent_slug=agent_slug,
                    )
                except asyncio.CancelledError:
                    log_stream_outcome(
                        logger,
                        logging.INFO,
                        "inference_stream_cancelled",
                        "Inference stream cancelled by client",
                        metrics=metrics,
                        context=request_context,
                        agent_id=current_conv.agent_id,
                        agent_slug=agent_slug,
                    )
                    return
        except asyncio.CancelledError:
            log_stream_outcome(
                logger,
                logging.INFO,
                "inference_stream_cancelled",
                "Inference request context cancelled",
                metrics=metrics,
                context=request_context,
                agent_id=current_conv.agent_id,
                agent_slug=agent_slug,
            )
            return
        except httpx.HTTPError as e:
            log_event(
                logger,
                logging.ERROR,
                "inference_upstream_error",
                "Inference upstream error",
                exc_info=True,
                context=request_context,
                upstream_service="agents",
                agent_id=current_conv.agent_id,
                agent_slug=agent_slug,
                error=str(e),
            )
            err = {
                "type": "RUN_ERROR",
                "message": "The inference service failed while processing the request.",
            }
            data = "data: " + json.dumps(err, ensure_ascii=False) + "\n\n"
            yield data.encode("utf-8")

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)
