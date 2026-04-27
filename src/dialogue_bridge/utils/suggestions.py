from typing import Any, Dict, List, Optional

import httpx

from core.proxy import internal_service_headers
from core.tls import get_httpx_verify
from observability import get_context, get_logger
from schemas import SuggestionsOut
from core.configs import settings

logger = get_logger(__name__)

_SUGGESTIONS_ENDPOINT = f"{settings.upstream.agents_service_url.rstrip('/')}/suggestions/generate"
_SUGGESTIONS_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=120.0, pool=10.0)
_SUGGESTION_MAX_LEN = 160
_SUGGESTION_MIN_CANDIDATES = 6


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
        async with httpx.AsyncClient(timeout=_SUGGESTIONS_TIMEOUT, verify=get_httpx_verify()) as client:
            response = await client.post(_SUGGESTIONS_ENDPOINT, json=payload, headers=upstream_headers)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning(
            "suggestion_generation_failed",
            "Conversation suggestion generation failed",
            upstream_service="agents",
            error=str(exc),
            failure_reason="upstream_error",
        )
        return []

    try:
        result = SuggestionsOut.model_validate(response.json())
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "suggestion_generation_invalid_payload",
            "Conversation suggestion generation returned an invalid payload",
            upstream_service="agents",
            error=str(exc),
            failure_reason="invalid_payload",
        )
        return []

    suggestions: list[str] = []
    seen: set[str] = set()
    for raw_suggestion in result.suggestions or []:
        suggestion = (raw_suggestion or "").strip()
        if not suggestion:
            continue
        if len(suggestion) > _SUGGESTION_MAX_LEN:
            suggestion = suggestion[:_SUGGESTION_MAX_LEN].rstrip()
        key = suggestion.casefold()
        if key in seen:
            continue
        seen.add(key)
        suggestions.append(suggestion)

    if len(suggestions) < _SUGGESTION_MIN_CANDIDATES:
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
    return suggestions[:10]
