import httpx
from fastapi import HTTPException, status
from observability import get_context, get_logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AgentTable, ConversationTable, UserPreferencesTable
from core.error_handling import upstream_error_handler
from core.proxy import internal_service_headers
from core.settings import settings
from core.tls import get_httpx_verify
from utils.validators import validate_convId_full


logger = get_logger(__name__)

_REALTIME_SESSION_ENDPOINT = f"{settings.upstream.agents_service_url.rstrip('/')}/realtime/session"


def normalize_realtime_voice(voice: str | None) -> str:
    selected = (voice or settings.voice.default_realtime_voice).strip().lower()
    return selected if selected in settings.voice.supported_realtime_voices else settings.voice.default_realtime_voice


def normalize_voice_mode_language(language: str | None) -> str:
    selected = (language or "english").strip().lower()
    return selected if selected in {"english", "greek"} else "english"


async def load_realtime_agent(db: AsyncSession, agent_id: str) -> AgentTable:
    result = await db.execute(select(AgentTable).where(AgentTable.id == agent_id, AgentTable.is_active == True))  # noqa: E712
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown or inactive agent.")
    return agent


async def load_owned_voice_conversation(db: AsyncSession, user_id: str, conversation_id: str) -> ConversationTable:
    return await validate_convId_full(user_id, conversation_id, db)


def recent_history_for_voice_instructions(conversation: ConversationTable) -> str:
    messages = list(getattr(conversation, "messages", []) or [])[-8:]
    lines: list[str] = []
    for message in messages:
        content = (message.content or "").strip()
        if not content:
            continue
        role = "User" if message.sender == "user" else "Assistant"
        lines.append(f"{role}: {content[:800]}")
    return "\n".join(lines)


def build_voice_instructions(
    agent: AgentTable,
    conversation: ConversationTable | None = None,
    language: str | None = None,
) -> str:
    recent_history = recent_history_for_voice_instructions(conversation) if conversation else ""
    language_instruction = {
        "english": "Use English as the default language for this live voice conversation.",
        "greek": "Use Greek as the default language for this live voice conversation.",
    }[normalize_voice_mode_language(language)]
    parts = [
        f"You are {agent.name}.",
        agent.description,
        "You are speaking in a live voice conversation. Keep responses concise, natural, and interruptible.",
        language_instruction,
        "If the user explicitly switches language, follow that instead.",
        "Do not describe UI state. Answer as a helpful assistant.",
    ]
    if recent_history:
        parts.append("Recent conversation context:\n" + recent_history)
    return "\n\n".join(part for part in parts if part.strip())


async def preferred_realtime_voice(db: AsyncSession, user_id: str, requested_voice: str | None) -> str:
    if requested_voice:
        return normalize_realtime_voice(requested_voice)
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    preferences = result.scalar_one_or_none()
    return normalize_realtime_voice(preferences.voice_mode_voice if preferences else None)


async def preferred_voice_mode_language(db: AsyncSession, user_id: str, requested_language: str | None) -> str:
    if requested_language:
        return normalize_voice_mode_language(requested_language)
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    preferences = result.scalar_one_or_none()
    return normalize_voice_mode_language(preferences.voice_mode_language if preferences else None)


async def create_realtime_session_with_agents(
    *,
    sdp: str,
    model: str,
    voice: str,
    instructions: str,
    metadata: dict,
) -> dict:
    """Ask the agents service to create an OpenAI Realtime WebRTC session."""
    request_id = get_context().get("request_id")
    headers = internal_service_headers(request_id)
    payload = {
        "sdp": sdp,
        "model": model,
        "voice": voice,
        "instructions": instructions,
        "metadata": metadata,
    }
    timeout = httpx.Timeout(connect=15.0, read=75.0, write=75.0, pool=15.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=get_httpx_verify()) as client:
            response = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.post(_REALTIME_SESSION_ENDPOINT, json=payload, headers=headers),
                upstream_service="agents",
                operation="realtime_voice_session",
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="realtime_voice_session_failed",
            message="Agents service returned an HTTP error while creating a realtime voice session",
            public_detail="Realtime voice is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="realtime_voice_session",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="realtime_voice_session_unreachable",
            message="Agents service could not be reached while creating a realtime voice session",
            public_detail="Realtime voice is temporarily unavailable. Please try again.",
            upstream_service="agents",
            operation="realtime_voice_session",
        )

    try:
        data = response.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger,
            exc,
            event="realtime_voice_session_invalid_json",
            message="Agents service returned invalid JSON for a realtime voice session",
            public_detail="Realtime voice returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="realtime_voice_session",
        )

    if not isinstance(data, dict) or not isinstance(data.get("sdp"), str):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Realtime voice returned an unexpected response. Please try again.",
        )
    return data
