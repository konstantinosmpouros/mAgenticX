import io
import json

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse

from core.clients import get_openai_client
from core.error_handling import provider_error_handler
from core.security.internal_trust import require_internal_caller
from core.settings import settings
from core.logging import get_logger
from schemas import (
    ReadAloudRequest,
    RealtimeSessionRequest,
    RealtimeSessionResponse,
    TranscriptionResponse,
)
from utils import generate_read_aloud_audio, normalize_realtime_voice

logger = get_logger(__name__)

router = APIRouter()


@router.post(
    "/dictate/transcribe",
    response_model=TranscriptionResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def transcribe_audio(file: UploadFile = File(...)) -> TranscriptionResponse:
    """
    Transcribe an uploaded audio file using OpenAI's Speech-to-Text capability.
    """
    stt_model = settings.runtime_models.dictation
    logger.info("dictation_request_received", "Dictation request received")

    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Audio file upload is required.",
        )

    try:
        audio_bytes = await file.read()
    except Exception as exc:
        logger.warning(
            "dictation_read_failed",
            "Failed to read dictation upload",
            exc_info=True,
            failure_reason="upload_read_failed",
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read the uploaded audio file.",
        ) from exc

    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded audio file is empty.",
        )

    content_type = (file.content_type or "application/octet-stream").strip().lower()
    logger.info("dictation_upload_read", "Dictation upload read successfully", content_type=content_type, upload_bytes=len(audio_bytes))

    audio_stream = io.BytesIO(audio_bytes)
    audio_stream.name = file.filename

    try:
        logger.info("dictation_provider_started", "Dictation provider request started", provider="openai", model=stt_model)
        transcription = get_openai_client().audio.transcriptions.create(
            model=stt_model,
            file=audio_stream,
        )
    except Exception as exc:
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="dictation_provider_failed",
            message="OpenAI transcription request failed",
            public_detail="Transcription is temporarily unavailable. Please try again.",
            provider="openai",
            operation="dictation",
            model=stt_model,
        )

    text = getattr(transcription, "text", None)
    if text is None and isinstance(transcription, dict):
        text = transcription.get("text")

    if text is None:
        logger.error(
            "dictation_provider_invalid_payload",
            "Transcription provider response did not include text",
            provider="openai",
            model=stt_model,
            failure_reason="missing_text",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Transcription returned an invalid response. Please try again.",
        )
    logger.info("dictation_transcribed", "Dictation transcribed successfully", provider="openai", model=stt_model, transcript_length=len(text))
    return TranscriptionResponse(text=text)


@router.post(
    "/speech/read-aloud",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def generate_read_aloud_speech(req: ReadAloudRequest):
    """Generate spoken audio for an AI response."""
    audio = await generate_read_aloud_audio(req)
    audio_format = settings.runtime_models.read_aloud_format
    media_type = "audio/mpeg" if audio_format == "mp3" else f"audio/{audio_format}"
    return StreamingResponse(
        io.BytesIO(audio),
        media_type=media_type,
        headers={
            "Content-Disposition": f'inline; filename="read-aloud.{audio_format}"',
        },
    )


@router.post(
    "/realtime/session",
    response_model=RealtimeSessionResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def create_realtime_session(req: RealtimeSessionRequest) -> RealtimeSessionResponse:
    """Create an OpenAI Realtime WebRTC session from an SDP offer."""
    api_key = settings.api_keys.openai.get_secret_value() if settings.api_keys.openai else None
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Realtime voice is not configured.",
        )

    model = (req.model or settings.runtime_models.realtime).strip()
    voice = normalize_realtime_voice(req.voice)
    session_config = {
        "type": "realtime",
        "model": model,
        "instructions": req.instructions,
        "audio": {
            "input": {
                "turn_detection": {"type": "server_vad"},
                "transcription": {"model": settings.runtime_models.dictation},
            },
            "output": {"voice": voice},
        },
    }
    multipart_fields = {
        "sdp": (None, req.sdp),
        "session": (None, json.dumps(session_config)),
    }
    try:
        async with httpx.AsyncClient(timeout=settings.realtime.timeout) as client:
            response = await client.post(
                settings.realtime.api_url,
                headers={"Authorization": f"Bearer {api_key}"},
                files=multipart_fields,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        max_chars = settings.realtime.error_body_max_chars
        upstream_body = exc.response.text[:max_chars]
        try:
            upstream_body = json.dumps(exc.response.json(), separators=(",", ":"))[:max_chars]
        except ValueError:
            pass
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="realtime_session_provider_http_error",
            message="OpenAI Realtime session request failed",
            public_detail="Realtime voice is temporarily unavailable. Please try again.",
            provider="openai",
            operation="realtime_session",
            model=model,
            upstream_status_code=exc.response.status_code,
            upstream_response_body=upstream_body,
        )
    except httpx.RequestError as exc:
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="realtime_session_provider_unreachable",
            message="OpenAI Realtime session request could not be completed",
            public_detail="Realtime voice is temporarily unavailable. Please try again.",
            provider="openai",
            operation="realtime_session",
            model=model,
        )

    logger.info("realtime_session_created", "Realtime voice session created", provider="openai", model=model, voice=voice)
    return RealtimeSessionResponse(sdp=response.text, model=model, voice=voice)
