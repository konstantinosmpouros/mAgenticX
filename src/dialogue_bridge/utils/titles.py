import logging
from typing import Any, Dict, List, Optional

import httpx

from schemas import MessageIn, TitleOut
from observability import get_context, log_event
from utils.agents import AGENTS_SERVICE_URL

logger = logging.getLogger(__name__)

_TITLE_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/titles/generate"
_TITLE_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=120.0, pool=10.0)
_TITLE_MAX_LEN = 120


def _message_to_chain_payload(message: MessageIn) -> List[Dict[str, Any]]:
    """Convert the inbound first message into the multimodal payload expected by the agents endpoint."""
    content_parts: List[Dict[str, Any]] = []
    attachments = message.attachments or []
    other_files: List[str] = []

    if message.content:
        content_parts.append({"type": "text", "text": message.content.strip()})

    for attachment in attachments:
        mime = (attachment.mime or "").lower()
        if mime.startswith("image/") and attachment.dataB64:
            data_url = f"data:{attachment.mime};base64,{attachment.dataB64}"
            content_parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": data_url,
                        "detail": "auto",
                    },
                }
            )
        else:
            label = attachment.name or "attachment"
            other_files.append(label)

    if other_files:
        summary = "Attachments included:\n" + "\n".join(f"- {name}" for name in other_files)
        content_parts.append({"type": "text", "text": summary})

    if not content_parts:
        content_parts.append({"type": "text", "text": ""})

    if len(content_parts) == 1 and content_parts[0]["type"] == "text":
        payload_content: Any = content_parts[0]["text"]
    else:
        payload_content = content_parts

    return [{"role": "user", "content": payload_content}]


async def generate_conversation_title(message: MessageIn) -> Optional[str]:
    """
    Call the agents service to obtain a generated conversation title.
    Returns None when the upstream call fails or the response is invalid.
    """
    payload = {"user_input": _message_to_chain_payload(message)}
    request_id = get_context().get("request_id")
    upstream_headers = {"X-Request-ID": request_id} if request_id else {}
    try:
        async with httpx.AsyncClient(timeout=_TITLE_TIMEOUT) as client:
            response = await client.post(_TITLE_ENDPOINT, json=payload, headers=upstream_headers)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        log_event(
            logger,
            logging.WARNING,
            "title_generation_failed",
            "Conversation title generation failed",
            upstream_service="agents",
            error=str(exc),
            failure_reason="upstream_error",
        )
        return None

    try:
        data = response.json()
        result = TitleOut.model_validate(data)
    except Exception as exc:  # pragma: no cover - defensive
        log_event(
            logger,
            logging.WARNING,
            "title_generation_invalid_payload",
            "Conversation title generation returned an invalid payload",
            upstream_service="agents",
            error=str(exc),
            failure_reason="invalid_payload",
        )
        return None

    raw_title = (result.title or "").strip()
    title = raw_title
    if not title:
        return None
    truncated = len(title) > _TITLE_MAX_LEN
    if len(title) > _TITLE_MAX_LEN:
        title = title[:_TITLE_MAX_LEN].rstrip()
    log_event(
        logger,
        logging.INFO,
        "title_generation_succeeded",
        "Conversation title generated successfully",
        title_length=len(title),
        truncated=truncated,
    )
    return title or None
