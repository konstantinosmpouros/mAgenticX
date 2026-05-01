from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from observability import get_logger, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth_session import require_csrf_protection
from core.database import ConversationTable, MessageTable, UserPreferencesTable, UserTable, get_db
from schemas import DictationResponse, ReadAloudPreviewRequest
from utils import (
    generate_read_aloud_audio,
    normalize_read_aloud_voice,
    read_aloud_response,
    transcribe_dictation_audio,
    validate_convId,
    validate_userId,
)


router = APIRouter()
logger = get_logger(__name__)


@router.post(
    "/dictation/{user_id}",
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
    set_context(user_id=user_id)

    try:
        audio_bytes = await audio.read()
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
    _current_user: UserTable = Depends(validate_userId),
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
    read_aloud_voice = normalize_read_aloud_voice(preferences.read_aloud_voice if preferences else None)

    audio, content_type = await generate_read_aloud_audio(msg.content or "", read_aloud_voice)
    logger.info(
        "message_read_aloud_generated",
        "Read-aloud audio generated for message",
        audio_bytes=len(audio),
        content_type=content_type,
        read_aloud_voice=read_aloud_voice,
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
    _current_user: UserTable = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
):
    set_context(user_id=user_id)
    read_aloud_voice = normalize_read_aloud_voice(payload.voice)
    audio, content_type = await generate_read_aloud_audio(payload.text, read_aloud_voice)
    logger.info(
        "read_aloud_preview_generated",
        "Read-aloud preview audio generated",
        audio_bytes=len(audio),
        content_type=content_type,
        read_aloud_voice=read_aloud_voice,
    )
    extension = "mp3" if content_type == "audio/mpeg" else content_type.split("/")[-1]
    return read_aloud_response(audio, content_type, f"read-aloud-preview-{read_aloud_voice}.{extension}")
