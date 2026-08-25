import random
from typing import Any, Dict, List, Optional

import httpx

from schemas import MessageIn, TitleOut
from core.logging import get_context, get_logger
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from core.security.internal_trust import internal_service_headers
from core.error_handling import upstream_error_handler
from utils.conversations import _preview

logger = get_logger(__name__)

_TITLE_ENDPOINT = f"{settings.upstream.agents_service_url.rstrip('/')}/titles/generate"


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


async def resolve_conversation_title(
    first_message: MessageIn,
    explicit_title: Optional[str],
    agent_name: Optional[str],
    agent_id: Optional[str],
) -> str:
    resolved = (explicit_title or "").strip() or None
    if resolved:
        return resolved
    generated = await generate_conversation_title(first_message)
    if generated:
        return generated
    preview = _preview(first_message.content)
    fallback_source = "preview" if preview else ("agent_name" if agent_name else "default")
    logger.info(
        "title_generation_fallback_used",
        "Conversation title fallback was used",
        agent_id=agent_id,
        fallback_source=fallback_source,
    )
    return preview or agent_name or "New conversation"


async def generate_conversation_title(message: MessageIn) -> Optional[str]:
    """
    Call the agents service to obtain generated conversation title candidates,
    then pick one at random for persistence.
    Returns None when the upstream call fails or the response is invalid.
    """
    payload = {"user_input": _message_to_chain_payload(message)}
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    try:
        async with httpx.AsyncClient(timeout=settings.http.generation_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            response = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.post(_TITLE_ENDPOINT, json=payload, headers=upstream_headers),
                upstream_service="agents",
                operation="title_generation",
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.log_http_error(
            logger,
            exc,
            event="title_generation_failed",
            message="Conversation title generation returned an HTTP error",
            upstream_service="agents",
            operation="title_generation",
        )
        return None
    except httpx.RequestError as exc:
        upstream_error_handler.log_request_error(
            logger,
            exc,
            event="title_generation_unreachable",
            message="Conversation title generation service could not be reached",
            upstream_service="agents",
            operation="title_generation",
        )
        return None

    try:
        data = response.json()
        result = TitleOut.model_validate(data)
    except Exception as exc:  # pragma: no cover - defensive
        upstream_error_handler.log_invalid_response(
            logger,
            exc,
            event="title_generation_invalid_payload",
            message="Conversation title generation returned an invalid payload",
            upstream_service="agents",
            operation="title_generation",
        )
        return None

    titles: List[str] = []
    seen: set[str] = set()
    truncated = False
    for raw_title in result.titles or []:
        title = (raw_title or "").strip()
        if not title:
            continue
        if len(title) > settings.generation.title_max_len:
            title = title[:settings.generation.title_max_len].rstrip()
            truncated = True
        key = title.casefold()
        if key in seen:
            continue
        seen.add(key)
        titles.append(title)

    if len(titles) < settings.generation.title_min_candidates:
        logger.warning(
            "title_generation_insufficient_candidates",
            "Conversation title generation returned too few usable candidates",
            upstream_service="agents",
            candidate_count=len(titles),
            failure_reason="insufficient_candidates",
        )
        return None

    selected_index = random.randrange(len(titles))
    title = titles[selected_index]
    logger.info(
        "title_generation_succeeded",
        "Conversation title generated successfully",
        title_length=len(title),
        truncated=truncated,
        candidate_count=len(titles),
        selected_index=selected_index,
    )
    return title or None
