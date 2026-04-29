from __future__ import annotations

import asyncio

from fastapi import HTTPException, status
from openai import OpenAI

from core.configs import configs
from core.error_handling import provider_error_handler
from observability import get_logger
from schemas import ReadAloudRequest

logger = get_logger(__name__)

_OPENAI_CLIENT = OpenAI(api_key=configs.api_keys.openai) if configs.api_keys.openai else OpenAI()


def _normalize_text(text: str) -> str:
    max_chars = max(1, configs.runtime_models.read_aloud_max_chars)
    return (text or "").strip()[:max_chars]


def _normalize_voice(voice: str | None) -> str:
    selected = (voice or configs.runtime_models.read_aloud_voice or "alloy").strip().lower()
    return selected or "alloy"


def _generate_speech_sync(text: str, voice: str) -> bytes:
    response = _OPENAI_CLIENT.audio.speech.create(
        model=configs.runtime_models.read_aloud,
        voice=voice,
        input=text,
        response_format=configs.runtime_models.read_aloud_format,
    )
    audio = getattr(response, "content", None)
    if isinstance(audio, bytes):
        return audio
    if audio is not None:
        return bytes(audio)
    read = getattr(response, "read", None)
    if callable(read):
        return read()
    raise RuntimeError("OpenAI speech response did not include audio bytes.")


async def generate_read_aloud_audio(req: ReadAloudRequest) -> bytes:
    text = _normalize_text(req.text)
    voice = _normalize_voice(req.voice)
    if not text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text is required for read-aloud audio.",
        )

    try:
        logger.info(
            "read_aloud_provider_started",
            "Read-aloud provider request started",
            provider="openai",
            model=configs.runtime_models.read_aloud,
            voice=voice,
            format=configs.runtime_models.read_aloud_format,
            text_length=len(text),
        )
        audio = await asyncio.to_thread(_generate_speech_sync, text, voice)
    except Exception as exc:
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="read_aloud_provider_failed",
            message="OpenAI read-aloud request failed",
            public_detail="Read-aloud is temporarily unavailable. Please try again.",
            provider="openai",
            operation="read_aloud",
            model=configs.runtime_models.read_aloud,
            voice=voice,
        )

    if not audio:
        logger.error(
            "read_aloud_provider_empty_audio",
            "Read-aloud provider returned empty audio",
            provider="openai",
            model=configs.runtime_models.read_aloud,
            failure_reason="empty_audio",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Read-aloud returned an invalid response. Please try again.",
        )

    logger.info(
        "read_aloud_provider_completed",
        "Read-aloud audio generated successfully",
        provider="openai",
        model=configs.runtime_models.read_aloud,
        voice=voice,
        audio_bytes=len(audio),
    )
    return audio
