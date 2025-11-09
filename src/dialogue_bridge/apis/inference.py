import asyncio
import json
import traceback

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from database import ConversationTable, UserTable, get_db
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


@router.post("/inference/stream")
async def startInferenceStream(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
    db: AsyncSession = Depends(get_db),
):
    """
    Proxy an inference stream from the selected agent to the UI as SSE.
    - Builds chat history for the agent as List[Dict[str, str]] (role/content only).
    - Looks up the agent slug from the conversation's agent.
    - POSTs to the agents service stream endpoint and forwards bytes as-is.
    Image attachments are forwarded to the agent as base64 data URLs.
    """
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

    # Build full chat history (role/content only)
    history = [serialise_message_with_images_for_agent(m) for m in current_conv.messages]

    async def event_stream():
        timeout = httpx.Timeout(connect=30.0, read=180.0, write=180.0, pool=30.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                try:
                    payload = {
                        "user_input": history,
                        "config": {
                            "run_config": {
                                "configurable": {
                                    "thread_id": str(conversation_id),
                                    "checkpoint_ns": str(agent_slug),
                                }
                            },
                            "agent_config": {
                                "user_id": str(user_id),
                                "conversation_id": str(conversation_id),
                                # "user_summary": None,
                            },
                        },
                    }
                    async with client.stream(
                        "POST",
                        agent_url,
                        json=payload,
                        headers={"Accept": "text/event-stream"},
                    ) as r:
                        r.raise_for_status()
                        async for chunk in r.aiter_bytes():
                            # Forward bytes directly (pre-encoded SSE from the agents service)
                            yield chunk
                except asyncio.CancelledError:
                    # Client interrupted streaming; exit silently to avoid noisy logs
                    return
        except asyncio.CancelledError:
            # Request context cancelled (e.g., UI aborted). Exit quietly.
            return
        except httpx.HTTPError as e:
            # Emit a RUN_ERROR frame so UI can gracefully handle upstream failures
            tb = traceback.format_exc()
            message = (
                tb.strip()
                if tb and tb.strip() and tb.strip() != "NoneType: None"
                else f"{type(e).__name__}: {e}"
            )
            err = {"type": "RUN_ERROR", "message": message}
            data = "data: " + json.dumps(err, ensure_ascii=False) + "\n\n"
            yield data.encode("utf-8")

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)
