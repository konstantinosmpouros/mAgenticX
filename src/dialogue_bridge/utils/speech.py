from __future__ import annotations

import httpx
from fastapi import HTTPException, status

from core.configs import settings
from core.proxy import internal_service_headers
from core.tls import get_httpx_verify
from observability import get_context, get_logger

logger = get_logger(__name__)

_READ_ALOUD_ENDPOINT = f"{settings.upstream.agents_service_url.rstrip('/')}/speech/read-aloud"


def normalize_read_aloud_voice(voice: str | None) -> str:
    selected = (voice or settings.speech.default_read_aloud_voice).strip().lower()
    return selected if selected in settings.speech.supported_read_aloud_voices else settings.speech.default_read_aloud_voice


_READ_ALOUD_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=120.0, pool=10.0)


async def generate_read_aloud_audio(text: str, voice: str | None = None) -> tuple[bytes, str]:
    payload = {"text": (text or "").strip(), "voice": (voice or "").strip() or None}
    if not payload["text"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Message does not contain readable text.",
        )

    request_id = get_context().get("request_id")
    try:
        async with httpx.AsyncClient(timeout=_READ_ALOUD_TIMEOUT, verify=get_httpx_verify()) as client:
            response = await client.post(
                _READ_ALOUD_ENDPOINT,
                json=payload,
                headers=internal_service_headers(request_id),
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "read_aloud_upstream_failed",
            "Read-aloud upstream request failed",
            upstream_service="agents",
            status_code=exc.response.status_code,
            error=str(exc),
            failure_reason="upstream_status",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Read-aloud generation failed.",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "read_aloud_upstream_unavailable",
            "Read-aloud upstream request could not be completed",
            upstream_service="agents",
            error=str(exc),
            failure_reason="upstream_error",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Read-aloud service is unavailable.",
        ) from exc

    audio = response.content
    if not audio:
        logger.warning(
            "read_aloud_empty_audio",
            "Read-aloud upstream returned empty audio",
            upstream_service="agents",
            failure_reason="empty_audio",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Read-aloud service returned empty audio.",
        )

    content_type = response.headers.get("content-type", "audio/mpeg").split(";")[0].strip() or "audio/mpeg"
    logger.info(
        "read_aloud_audio_received",
        "Read-aloud audio received from agents service",
        audio_bytes=len(audio),
        content_type=content_type,
    )
    return audio, content_type
