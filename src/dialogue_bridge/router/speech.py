from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from core.logging import get_logger, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection
from core.database import ConversationTable, MessageTable, UserPreferencesTable, get_db
from core.security.rate_limit import speech_rate_limit
from schemas import DictationResponse, ReadAloudPreviewRequest
from utils import (
    generate_read_aloud_audio,
    normalize_realtime_voice,
    read_aloud_response,
    read_capped_dictation_audio,
    transcribe_dictation_audio,
    validate_convId,
    validate_userId,
)


# Every speech endpoint proxies a paid OpenAI audio API — one per-user ceiling
# covers the whole router (dictation, read-aloud, previews).
router = APIRouter(dependencies=[Depends(speech_rate_limit)])
logger = get_logger(__name__)


@router.post(
    "/dictation/{user_id}",
    response_model=DictationResponse,
    status_code=status.HTTP_200_OK,
)
async def transcribe_dictation(
    user_id: str,
    audio: UploadFile = File(...),
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
) -> DictationResponse:
    """
    Accept an audio upload from the UI, proxy it to the agents STT endpoint,
    and return the transcription text.
    """
    set_context(user_id=user_id)

    try:
        audio_bytes = await read_capped_dictation_audio(audio)
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(
            "dictation_read_failed",
            "Failed to read dictation upload",
            exc_info=True,
            error=str(exc),
            failure_reason="upload_read_failed",
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read the uploaded audio file.",
        ) from exc

    return await transcribe_dictation_audio(
        audio_bytes,
        filename=audio.filename,
        content_type=audio.content_type,
    )


@router.post(
    "/read-aloud/{user_id}/{conversation_id}/{message_id}",
    status_code=status.HTTP_200_OK,
    summary="Generate read-aloud audio for an AI message",
)
async def readMessageAloud(
    user_id: str,
    conversation_id: str,
    message_id: str,
    _current_user: AuthUser = Depends(validate_userId),
    _current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=message_id)
    stmt = select(MessageTable).where(
        MessageTable.id == message_id,
        MessageTable.conversation_id == conversation_id,
    )
    res = await db.execute(stmt)
    msg = res.scalar_one_or_none()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")
    if msg.sender != "ai":
        raise HTTPException(status_code=400, detail="Only AI messages can be read aloud.")

    preferences_res = await db.execute(
        select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id)
    )
    preferences = preferences_res.scalar_one_or_none()
    voice = normalize_realtime_voice(preferences.voice_mode_voice if preferences else None)

    audio, content_type = await generate_read_aloud_audio(msg.content or "", voice)
    logger.info(
        "message_read_aloud_generated",
        "Read-aloud audio generated for message",
        audio_bytes=len(audio),
        content_type=content_type,
        voice_mode_voice=voice,
    )
    extension = "mp3" if content_type == "audio/mpeg" else content_type.split("/")[-1]
    return read_aloud_response(audio, content_type, f"read-aloud-{message_id}.{extension}")


@router.post(
    "/read-aloud-preview/{user_id}",
    status_code=status.HTTP_200_OK,
    summary="Generate a short read-aloud voice preview",
)
async def previewReadAloudVoice(
    user_id: str,
    payload: ReadAloudPreviewRequest,
    _current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
):
    set_context(user_id=user_id)
    voice = normalize_realtime_voice(payload.voice)
    audio, content_type = await generate_read_aloud_audio(payload.text, voice)
    logger.info(
        "read_aloud_preview_generated",
        "Read-aloud preview audio generated",
        audio_bytes=len(audio),
        content_type=content_type,
        voice_mode_voice=voice,
    )
    extension = "mp3" if content_type == "audio/mpeg" else content_type.split("/")[-1]
    return read_aloud_response(audio, content_type, f"read-aloud-preview-{voice}.{extension}")
