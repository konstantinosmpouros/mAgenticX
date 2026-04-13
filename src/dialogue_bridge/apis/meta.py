from fastapi import APIRouter, Depends, File, UploadFile, status, HTTPException
import httpx
from observability import get_context, get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, UserTable, UserPreferencesTable
from schemas import AgentPublic, DictationResponse, ToolManifest, UserPreferences
from utils import (
    AGENTS_SERVICE_URL,
    fetch_tools_from_agents_service,
    get_cached_agents,
    sync_agents_with_service,
    validate_userId,
)
from vault_auth.session_auth import require_csrf_protection, require_current_user
from sqlalchemy import select


router = APIRouter(tags=["Utilities"])
logger = get_logger(__name__)


@router.post(
    "/users/{user_id}/dictation/transcribe",
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
            async with httpx.AsyncClient(timeout=timeout) as client:
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


@router.get("/agents", response_model=list[AgentPublic], status_code=status.HTTP_200_OK)
async def get_available_agents(_: UserTable = Depends(require_current_user), db: AsyncSession = Depends(get_db)):
    """
    Return the active agents, preferring the in-memory cache and refreshing
    from the agents service only when the cache is empty.
    """
    # Try to get agents from cache first
    agents = get_cached_agents()
    if agents:
        logger.info("agents_cache_hit", "Served agents from cache", count=len(agents))
    # If cache is empty, sync with agents service once more
    if not agents:
        logger.info("agents_cache_miss", "Agent cache empty; synchronizing with agents service")
        agents = await sync_agents_with_service(db)
    return [AgentPublic.model_validate(a) for a in agents]


@router.get("/tools", response_model=list[ToolManifest], status_code=status.HTTP_200_OK)
async def get_available_tools(_: UserTable = Depends(require_current_user),):
    """Return the tools exposed by the MCP server via the agents service."""
    payload = await fetch_tools_from_agents_service()
    logger.info("tools_fetched", "Fetched tools from agents service", count=len(payload))
    return [ToolManifest.model_validate(item) for item in payload]


@router.get("/users/{user_id}/preferences", response_model=UserPreferences, status_code=status.HTTP_200_OK)
async def get_user_preferences(
    user_id: str,
    _: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """
    Return generic user preferences (future-proof JSON) scoped to the given user.
    Currently supports tools.disabled list.
    """
    set_context(user_id=user_id)
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    row: UserPreferencesTable | None = result.scalar_one_or_none()
    if row is None:
        logger.info("preferences_defaulted", "No stored user preferences found")
        return UserPreferences()

    payload: dict = {
        "tools": row.tools if isinstance(row.tools, dict) else {},
        "prefers_agentic_chat": bool(row.prefers_agentic_chat),
    }
    logger.info("preferences_loaded", "Loaded user preferences")
    return UserPreferences.model_validate(payload)


@router.put("/users/{user_id}/preferences", response_model=UserPreferences, status_code=status.HTTP_200_OK)
async def upsert_user_preferences(
    user_id: str,
    payload: UserPreferences,
    _: UserTable = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """
    Replace the user's preferences document with the provided payload.
    """
    set_context(user_id=user_id)
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    existing: UserPreferencesTable | None = result.scalar_one_or_none()
    if existing:
        existing.tools = payload.tools.model_dump(mode="json", by_alias=True)
        existing.prefers_agentic_chat = bool(payload.prefersAgenticChat)
    else:
        db.add(
            UserPreferencesTable(
                user_id=user_id,
                tools=payload.tools.model_dump(mode="json", by_alias=True),
                prefers_agentic_chat=bool(payload.prefersAgenticChat),
            )
        )

    await db.commit()
    logger.info("preferences_updated", "Updated user preferences", disabled_tools=len(payload.tools.disabled), prefers_agentic_chat=bool(payload.prefersAgenticChat))
    return payload
