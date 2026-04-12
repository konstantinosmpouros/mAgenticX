import asyncio
import json
import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from observability import log_event, set_context
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from database import ConversationTable, UserTable, MessageTable, get_db
from database.schemas import InferenceStreamPayload
from vault_auth.session_auth import require_csrf_protection
from utils import (
    build_agent_stream_url,
    get_agent_by_id,
    serialise_message_with_images_for_agent,
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
    db: AsyncSession = Depends(get_db),
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
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Agent metadata unavailable for this conversation",
        )
    agent_slug = getattr(agent, "slug", None)
    if not agent_slug:
        raise HTTPException(status_code=500, detail="Agent slug not available for this conversation")
    agent_url = build_agent_stream_url(agent_slug)
    
    # Build chat history for the requested branch (fallback = whole conversation)
    message_ids = payload.messagePath if payload and payload.messagePath else None
    history_messages: list[MessageTable]
    placeholder_stripped = False
    
    # Validate and order message IDs if provided to match the branch path
    if message_ids:
        cleaned_ids: list[str] = []
        for raw_id in message_ids:
            if not isinstance(raw_id, str) or not raw_id.strip():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="messagePath contains invalid ids.",
                )
            cleaned_ids.append(raw_id.strip())
        
        if len(set(cleaned_ids)) != len(cleaned_ids):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="messagePath contains duplicates.")
        
        lookup = {message.id: message for message in current_conv.messages}
        ordered_messages = []
        for m_id in cleaned_ids:
            match = lookup.get(m_id)
            if not match:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="messagePath references messages outside this conversation or messagePath is corrupted.",
                )
            ordered_messages.append(match)
        history_messages = ordered_messages
    else:
        history_messages = current_conv.messages

    # If the last message is an empty AI placeholder, exclude it from agent history
    # while keeping its id in the thread_id (messagePath) to isolate the checkpointer.
    if history_messages:
        last_msg = history_messages[-1]
        is_placeholder = (
            last_msg.sender == "ai"
            and not last_msg.content
            and (not getattr(last_msg, "attachments", None))
        )
        if is_placeholder:
            placeholder_stripped = True
            history_messages = history_messages[:-1]
    
    # Serialise messages for agent
    history = [serialise_message_with_images_for_agent(m) for m in history_messages]
    enabled_tools = payload.enabledTools if payload else None
    log_event(
        logger,
        logging.INFO,
        "inference_branch_resolved",
        "Inference branch resolved",
        user_id=user_id,
        conversation_id=conversation_id,
        requested_message_path_length=len(message_ids or []),
        branch_source="message_path" if message_ids else "conversation",
        placeholder_stripped=placeholder_stripped,
        resolved_history_messages=len(history_messages),
        serialised_messages=len(history),
        enabled_tools=len(enabled_tools or []),
    )
    log_event(
        logger,
        logging.INFO,
        "inference_stream_started",
        "Inference stream started",
        user_id=user_id,
        conversation_id=conversation_id,
        agent_id=current_conv.agent_id,
        history_messages=len(history_messages),
        enabled_tools=len(enabled_tools or []),
    )
    
    # Stream inference from agent service to client
    async def event_stream():
        stream_started_at = time.perf_counter()
        timeout = httpx.Timeout(connect=30.0, read=180.0, write=180.0, pool=30.0)
        chunk_count = 0
        event_count = 0
        bytes_forwarded = 0
        first_byte_latency_ms: float | None = None
        pending = b""
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
                    upstream_started_at = time.perf_counter()
                    async with client.stream(
                        "POST",
                        agent_url,
                        json=req_payload,
                        headers={"Accept": "text/event-stream"},
                    ) as r:
                        r.raise_for_status()
                        upstream_connect_latency_ms = round((time.perf_counter() - upstream_started_at) * 1000, 2)
                        log_event(
                            logger,
                            logging.INFO,
                            "inference_upstream_connected",
                            "Inference upstream stream connected",
                            user_id=user_id,
                            conversation_id=conversation_id,
                            agent_url=agent_url,
                            upstream_status_code=r.status_code,
                            upstream_connect_latency_ms=upstream_connect_latency_ms,
                        )
                        async for chunk in r.aiter_bytes():
                            # Forward bytes directly (pre-encoded SSE from the agents service)
                            if first_byte_latency_ms is None:
                                first_byte_latency_ms = round((time.perf_counter() - stream_started_at) * 1000, 2)
                            chunk_count += 1
                            bytes_forwarded += len(chunk)
                            pending += chunk.replace(b"\r\n", b"\n")
                            while b"\n\n" in pending:
                                _, pending = pending.split(b"\n\n", 1)
                                event_count += 1
                            yield chunk
                    if pending.strip():
                        event_count += 1
                    total_stream_duration_ms = round((time.perf_counter() - stream_started_at) * 1000, 2)
                    log_event(
                        logger,
                        logging.INFO,
                        "inference_stream_completed",
                        "Inference stream completed",
                        user_id=user_id,
                        conversation_id=conversation_id,
                        agent_url=agent_url,
                        chunk_count=chunk_count,
                        event_count=event_count,
                        bytes_forwarded=bytes_forwarded,
                        first_byte_latency_ms=first_byte_latency_ms,
                        total_stream_duration_ms=total_stream_duration_ms,
                    )
                except asyncio.CancelledError:
                    total_stream_duration_ms = round((time.perf_counter() - stream_started_at) * 1000, 2)
                    log_event(
                        logger,
                        logging.INFO,
                        "inference_stream_cancelled",
                        "Inference stream cancelled by client",
                        user_id=user_id,
                        conversation_id=conversation_id,
                        chunk_count=chunk_count,
                        event_count=event_count,
                        bytes_forwarded=bytes_forwarded,
                        first_byte_latency_ms=first_byte_latency_ms,
                        total_stream_duration_ms=total_stream_duration_ms,
                    )
                    return # Client interrupted streaming; exit silently to avoid noisy logs
        except asyncio.CancelledError:
            total_stream_duration_ms = round((time.perf_counter() - stream_started_at) * 1000, 2)
            log_event(
                logger,
                logging.INFO,
                "inference_stream_cancelled",
                "Inference request context cancelled",
                user_id=user_id,
                conversation_id=conversation_id,
                chunk_count=chunk_count,
                event_count=event_count,
                bytes_forwarded=bytes_forwarded,
                first_byte_latency_ms=first_byte_latency_ms,
                total_stream_duration_ms=total_stream_duration_ms,
            )
            return # Request context cancelled (e.g., UI aborted). Exit quietly.
        except httpx.HTTPError as e:
            # Keep the detailed traceback in server logs, but return a generic
            # upstream error to the authenticated UI client.
            logger.exception(
                "Inference upstream error",
                extra={
                    "event": "inference_upstream_error",
                    "event_data": {
                        "user_id": user_id,
                        "conversation_id": conversation_id,
                        "agent_url": agent_url,
                        "error": str(e),
                    },
                },
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
