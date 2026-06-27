from __future__ import annotations

import io

import httpx
from fastapi import HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse

from core.settings import settings
from core.error_handling import upstream_error_handler
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from observability import get_context, get_logger
from schemas import DictationResponse

logger = get_logger(__name__)

_DICTATION_ENDPOINT = f"{settings.upstream.agents_service_url.rstrip('/')}/dictate/transcribe"
DICTATION_TOO_LARGE_DETAIL = (
    f"The audio recording is too large. Please record a shorter clip "
    f"({settings.speech.dictation_max_bytes // (1024 * 1024)} MB or less)."
)
DICTATION_UNSUPPORTED_MEDIA_DETAIL = "Unsupported audio format. Please record an audio clip."
_READ_ALOUD_ENDPOINT = f"{settings.upstream.agents_service_url.rstrip('/')}/speech/read-aloud"
MAX_READ_ALOUD_TEXT_CHARS = settings.speech.read_aloud_max_chars
READ_ALOUD_TEXT_TOO_LONG_DETAIL = (
    f"This message is too long to read aloud. Please choose a shorter message "
    f"({MAX_READ_ALOUD_TEXT_CHARS:,} characters or fewer)."
)


def read_aloud_response(audio: bytes, content_type: str, filename: str) -> StreamingResponse:
    return StreamingResponse(
        io.BytesIO(audio),
        media_type=content_type,
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


async def read_capped_dictation_audio(audio: UploadFile) -> bytes:
    # MediaRecorder tags blobs with codec params (e.g. "audio/webm;codecs=opus"),
    # so match only the base content type. Reject non-audio uploads up front.
    base_mime = (audio.content_type or "").split(";")[0].strip().lower()
    if not base_mime.startswith("audio/"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=DICTATION_UNSUPPORTED_MEDIA_DETAIL,
        )
    # Read in bounded chunks so an oversized body is rejected before the whole
    # payload is buffered into memory.
    buffer = bytearray()
    while chunk := await audio.read(settings.speech.dictation_read_chunk_bytes):
        buffer.extend(chunk)
        if len(buffer) > settings.speech.dictation_max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=DICTATION_TOO_LARGE_DETAIL,
            )
    return bytes(buffer)


async def transcribe_dictation_audio(
    audio_bytes: bytes,
    *,
    filename: str | None = None,
    content_type: str | None = None,
) -> DictationResponse:
    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded audio file is empty.",
        )

    resolved_content_type = content_type or "application/octet-stream"
    files = {
        "file": (filename or "dictation.wav", audio_bytes, resolved_content_type),
    }

    request_id = get_context().get("request_id")
    upstream_headers = internal_service_headers(request_id)
    try:
        async with httpx.AsyncClient(timeout=settings.http.generation_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            response = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.post(_DICTATION_ENDPOINT, files=files, headers=upstream_headers),
                upstream_service="agents",
                operation="dictation",
            )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="dictation_upstream_http_error",
            message="Speech-to-text service returned an HTTP error",
            public_detail="Speech-to-text service could not process the audio. Please try again.",
            upstream_service="agents",
            operation="dictation",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="dictation_upstream_unreachable",
            message="Failed to reach speech-to-text service",
            public_detail="Speech-to-text service is temporarily unavailable. Please try again shortly.",
            upstream_service="agents",
            operation="dictation",
        )

    try:
        payload = response.json()
    except ValueError as exc:
        upstream_error_handler.raise_invalid_response(
            logger,
            exc,
            event="dictation_invalid_json",
            message="STT service returned non-JSON response",
            public_detail="Speech-to-text service returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="dictation",
        )

    try:
        result = DictationResponse.model_validate(payload)
    except Exception as exc:
        upstream_error_handler.raise_invalid_response(
            logger,
            exc,
            event="dictation_invalid_payload",
            message="Speech-to-text service returned an invalid payload",
            public_detail="Speech-to-text service returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="dictation",
        )

    logger.info(
        "dictation_transcribed",
        "Speech-to-text transcription completed",
        content_type=resolved_content_type,
        upload_bytes=len(audio_bytes),
        transcript_length=len(result.text),
    )
    return result


async def generate_read_aloud_audio(text: str, voice: str | None = None) -> tuple[bytes, str]:
    readable_text = (text or "").strip()
    if not readable_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Message does not contain readable text.",
        )
    if len(readable_text) > MAX_READ_ALOUD_TEXT_CHARS:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=READ_ALOUD_TEXT_TOO_LONG_DETAIL,
        )

    payload = {"text": readable_text, "voice": (voice or "").strip() or None}

    request_id = get_context().get("request_id")
    try:
        async with httpx.AsyncClient(timeout=settings.http.generation_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()) as client:
            response = await upstream_error_handler.run_with_retries(
                logger,
                lambda: client.post(
                    _READ_ALOUD_ENDPOINT,
                    json=payload,
                    headers=internal_service_headers(request_id),
                ),
                upstream_service="agents",
                operation="read_aloud",
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        upstream_error_handler.raise_http_error(
            logger,
            exc,
            event="read_aloud_upstream_failed",
            message="Read-aloud upstream request failed",
            public_detail="Read-aloud generation failed. Please try again.",
            upstream_service="agents",
            operation="read_aloud",
        )
    except httpx.RequestError as exc:
        upstream_error_handler.raise_request_error(
            logger,
            exc,
            event="read_aloud_upstream_unavailable",
            message="Read-aloud upstream request could not be completed",
            public_detail="Read-aloud service is temporarily unavailable. Please try again shortly.",
            upstream_service="agents",
            operation="read_aloud",
        )

    audio = response.content
    if not audio:
        upstream_error_handler.raise_invalid_response(
            logger,
            event="read_aloud_empty_audio",
            message="Read-aloud upstream returned empty audio",
            public_detail="Read-aloud service returned an unexpected response. Please try again.",
            upstream_service="agents",
            operation="read_aloud",
        )

    content_type = response.headers.get("content-type", "audio/mpeg").split(";")[0].strip() or "audio/mpeg"
    logger.info(
        "read_aloud_audio_received",
        "Read-aloud audio received from agents service",
        audio_bytes=len(audio),
        content_type=content_type,
    )
    return audio, content_type
