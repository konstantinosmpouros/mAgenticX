from fastapi import APIRouter, Depends, File, UploadFile, status, HTTPException
import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, UserTable
from database.schemas import AgentPublic, DictationResponse, ToolManifest
from utils import (
    AGENTS_SERVICE_URL,
    fetch_tools_from_agents_service,
    get_cached_agents,
    sync_agents_with_service,
    validate_userId,
)
from vault_auth.auth import require_token_claims


router = APIRouter(tags=["Utilities"])


@router.post(
    "/users/{user_id}/dictation/transcribe",
    response_model=DictationResponse,
    status_code=status.HTTP_200_OK,
)
async def transcribe_dictation(
    user_id: str,
    audio: UploadFile = File(...),
    _: UserTable = Depends(validate_userId),
) -> DictationResponse:
    """
    Accept an audio upload from the UI, proxy it to the agents STT endpoint,
    and return the transcription text.
    """
    _AGENTS_STT_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/dictate/transcribe"
    filename = audio.filename or "dictation.wav"

    try:
        audio_bytes = await audio.read()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read uploaded audio file: {exc}",
        ) from exc

    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded audio file is empty.",
        )

    content_type = audio.content_type or "application/octet-stream"
    files = {
        "file": (filename, audio_bytes, content_type),
    }

    timeout = httpx.Timeout(connect=10.0, read=120.0, write=120.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(_AGENTS_STT_ENDPOINT, files=files)
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail_snippet = exc.response.text.strip()
        if len(detail_snippet) > 200:
            detail_snippet = detail_snippet[:197] + "..."
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"STT service error ({exc.response.status_code}): {detail_snippet or 'No response body'}",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to reach STT service: {exc}",
        ) from exc

    try:
        payload = resp.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="STT service returned invalid JSON payload.",
        ) from exc

    try:
        return DictationResponse.model_validate(payload)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"STT service payload validation failed: {exc}",
        ) from exc


@router.get("/agents", response_model=list[AgentPublic], status_code=status.HTTP_200_OK)
async def get_available_agents(
    _: dict = Depends(require_token_claims),
    db: AsyncSession = Depends(get_db),
):
    """
    Return the active agents, preferring the in-memory cache and refreshing
    from the agents service only when the cache is empty.
    """
    # Try to get agents from cache first
    agents = get_cached_agents()
    # If cache is empty, sync with agents service once more
    if not agents:
        agents = await sync_agents_with_service(db)
    return [AgentPublic.model_validate(a) for a in agents]


@router.get("/tools", response_model=list[ToolManifest], status_code=status.HTTP_200_OK)
async def get_available_tools(
    _: dict = Depends(require_token_claims),
):
    """Return the tools exposed by the MCP server via the agents service."""
    payload = await fetch_tools_from_agents_service()
    return [ToolManifest.model_validate(item) for item in payload]
