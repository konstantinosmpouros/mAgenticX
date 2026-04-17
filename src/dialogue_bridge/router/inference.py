import asyncio
import json
import logging
import time

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from observability import StreamMetrics, elapsed_ms, get_context, get_logger, iter_tracked_stream, log_stream_outcome, set_context

from core.database import ConversationTable, UserTable
from core.tls import get_httpx_verify
from schemas import DictationResponse, InferenceStreamPayload
from core.auth_session import require_csrf_protection
from utils import (
    AGENTS_SERVICE_URL,
    build_agent_stream_url,
    get_agent_by_id,
    prepare_inference_history,
    validate_convId_full,
    validate_userId,
)


router = APIRouter()

logger = get_logger(__name__)


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


@router.post(
    "/dictation/{user_id}",
    response_model=DictationResponse,
    status_code=status.HTTP_200_OK,
)
async def transcribe_dictation(
    user_id: str,
    audio: UploadFile = File(...),
    _: UserTable = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
) -> DictationResponse:
    """
    Accept an audio upload from the UI, proxy it to the agents STT endpoint,
    and return the transcription text.
    """
    _AGENTS_STT_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/dictate/transcribe"
    set_context(user_id=user_id)

    try:
        audio_bytes = await audio.read()
    except Exception as exc:
        logger.warning("dictation_read_failed", "Failed to read dictation upload", error=str(exc), failure_reason="upload_read_failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read the uploaded audio file.",
        ) from exc

    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded audio file is empty.",
        )

    content_type = audio.content_type or "application/octet-stream"
    files = {
        "file": (audio.filename or "dictation.wav", audio_bytes, content_type),
    }

    request_id = get_context().get("request_id")
    upstream_headers = {"X-Request-ID": request_id} if request_id else {}
    timeout = httpx.Timeout(connect=10.0, read=120.0, write=120.0, pool=10.0)
    try:
            async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
                resp = await client.post(_AGENTS_STT_ENDPOINT, files=files, headers=upstream_headers)
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        logger.warning("dictation_upstream_http_error", "Speech-to-text service returned an HTTP error", upstream_service="agents", status_code=exc.response.status_code, failure_reason="upstream_http_error")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Speech-to-text service failed to process the audio.",
        ) from exc
    except httpx.RequestError as exc:
        logger.warning("dictation_upstream_unreachable", "Failed to reach speech-to-text service", upstream_service="agents", error=str(exc), failure_reason="upstream_unreachable")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Speech-to-text service is unavailable.",
        ) from exc

    try:
        payload = resp.json()
    except ValueError as exc:
        logger.error("dictation_invalid_json", "STT service returned non-JSON response", exc_info=True, upstream_service="agents", failure_reason="invalid_json")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="STT service returned invalid JSON payload.",
        ) from exc

    try:
        result = DictationResponse.model_validate(payload)
    except Exception as exc:
        logger.warning("dictation_invalid_payload", "Speech-to-text service returned an invalid payload", error=str(exc), upstream_service="agents", failure_reason="invalid_payload")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Speech-to-text service returned an invalid response.",
        ) from exc
    logger.info("dictation_transcribed", "Speech-to-text transcription completed", content_type=content_type, upload_bytes=len(audio_bytes), transcript_length=len(result.text))
    return result
