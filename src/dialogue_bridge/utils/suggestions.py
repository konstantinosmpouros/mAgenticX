from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import ConversationTable
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.logging import get_context, get_logger
from schemas import SuggestionsOut
from core.settings import settings
from core.error_handling import upstream_error_handler

logger = get_logger(__name__)

_SUGGESTIONS_ENDPOINT = f"{settings.upstream.agents_service_url.rstrip('/')}/suggestions/generate"


async def recent_conversations_for_suggestions(db: AsyncSession, user_id: str) -> List[Dict[str, Any]]:
    """Load the user's recent non-private conversations as suggestion context."""
    result = await db.execute(
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
        .where(
            ConversationTable.user_id == user_id,
            ConversationTable.is_private == False,
        )
        .order_by(ConversationTable.updated_at.desc())
        .limit(settings.generation.suggestion_recent_context_count)
    )
    conversations = result.scalars().all()
    return [
        {
            "title": conversation.title,
            "last_message": conversation.last_message_preview,
            "agent_name": conversation.agent.name if conversation.agent else conversation.agent_name,
        }
        for conversation in conversations
    ]


def build_suggestion_context_payload(
    *,
    agent_name: Optional[str],
    agent_description: Optional[str],
    recent_conversations: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Build the text payload sent to the agents suggestion endpoint."""
    context_lines: list[str] = [
        "Generate starter prompts for a new chat composer.",
    ]

    if agent_name:
        context_lines.append(f"Selected agent: {agent_name}")
    if agent_description:
        context_lines.append(f"Selected agent description: {agent_description}")

    if recent_conversations:
        context_lines.append("Recent conversation context:")
        for idx, conversation in enumerate(recent_conversations, start=1):
            title = (conversation.get("title") or "Untitled conversation").strip()
            preview = (conversation.get("last_message") or "").strip()
            agent = (conversation.get("agent_name") or "").strip()
            parts = [f"{idx}. {title}"]
            if agent:
                parts.append(f"agent={agent}")
            if preview:
                parts.append(f"last_message={preview}")
            context_lines.append(" | ".join(parts))
    else:
        context_lines.append("No recent conversation context is available. Generate broadly useful starters.")

    return [{"role": "user", "content": "\n".join(context_lines)}]


async def generate_conversation_suggestions(
    *,
    agent_name: Optional[str],
    agent_description: Optional[str],
    recent_conversations: List[Dict[str, Any]],
) -> List[str]:
    """Call the agents service to generate new-chat suggestion candidates."""
    payload = {
        "user_input": build_suggestion_context_payload(
            agent_name=agent_name,
            agent_description=agent_description,
            recent_conversations=recent_conversations,
        )
    }
    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    try:
        async with httpx.AsyncClient(timeout=settings.http.generation_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            response = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.post(_SUGGESTIONS_ENDPOINT, json=payload, headers=upstream_headers),
                upstream_service="agents",
                operation="suggestion_generation",
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.log_http_error(
            logger,
            exc,
            event="suggestion_generation_failed",
            message="Conversation suggestion generation returned an HTTP error",
            upstream_service="agents",
            operation="suggestion_generation",
        )
        return []
    except httpx.RequestError as exc:
        upstream_error_handler.log_request_error(
            logger,
            exc,
            event="suggestion_generation_unreachable",
            message="Conversation suggestion generation service could not be reached",
            upstream_service="agents",
            operation="suggestion_generation",
        )
        return []

    try:
        result = SuggestionsOut.model_validate(response.json())
    except Exception as exc:  # pragma: no cover - defensive
        upstream_error_handler.log_invalid_response(
            logger,
            exc,
            event="suggestion_generation_invalid_payload",
            message="Conversation suggestion generation returned an invalid payload",
            upstream_service="agents",
            operation="suggestion_generation",
        )
        return []

    suggestions: list[str] = []
    seen: set[str] = set()
    for raw_suggestion in result.suggestions or []:
        suggestion = (raw_suggestion or "").strip()
        if not suggestion:
            continue
        if len(suggestion) > settings.generation.suggestion_max_len:
            suggestion = suggestion[:settings.generation.suggestion_max_len].rstrip()
        key = suggestion.casefold()
        if key in seen:
            continue
        seen.add(key)
        suggestions.append(suggestion)

    if len(suggestions) < settings.generation.suggestion_min_candidates:
        logger.warning(
            "suggestion_generation_insufficient_candidates",
            "Conversation suggestion generation returned too few usable candidates",
            upstream_service="agents",
            candidate_count=len(suggestions),
            failure_reason="insufficient_candidates",
        )
        return []

    logger.info(
        "suggestion_generation_succeeded",
        "Conversation suggestions generated successfully",
        candidate_count=len(suggestions),
    )
    return suggestions[:settings.generation.suggestion_count]
