from __future__ import annotations

from types import SimpleNamespace

from fastapi import HTTPException

from router import speech as speech_router
from utils.speech import MAX_READ_ALOUD_TEXT_CHARS, READ_ALOUD_TEXT_TOO_LONG_DETAIL


async def test_dictation_route_returns_transcript(client, seeded_user, monkeypatch):
    async def fake_transcribe(audio_bytes, *, filename, content_type):
        assert audio_bytes == b"wave-data"
        assert filename == "memo.wav"
        assert content_type == "audio/wav"
        return SimpleNamespace(text="transcribed text")

    monkeypatch.setattr(speech_router, "transcribe_dictation_audio", fake_transcribe)

    response = await client.post(
        f"/v1/speech/dictation/{seeded_user.id}",
        files={"audio": ("memo.wav", b"wave-data", "audio/wav")},
    )

    assert response.status_code == 200
    assert response.json() == {"text": "transcribed text"}


async def test_dictation_route_rejects_invalid_upstream_payload(client, seeded_user, monkeypatch):
    async def fake_transcribe(audio_bytes, *, filename, content_type):
        raise HTTPException(status_code=502, detail="Speech-to-text service returned an invalid response.")

    monkeypatch.setattr(speech_router, "transcribe_dictation_audio", fake_transcribe)

    response = await client.post(
        f"/v1/speech/dictation/{seeded_user.id}",
        files={"audio": ("memo.wav", b"wave-data", "audio/wav")},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "Speech-to-text service returned an invalid response."


async def test_read_aloud_preview_route_streams_sample_audio(client, seeded_user, monkeypatch):
    async def fake_generate_read_aloud_audio(text, voice):
        assert text == "Hey! I am your AI speaker."
        assert voice == "nova"
        return b"preview-audio", "audio/mpeg"

    monkeypatch.setattr(speech_router, "generate_read_aloud_audio", fake_generate_read_aloud_audio)

    response = await client.post(
        f"/v1/speech/read-aloud-preview/{seeded_user.id}",
        json={"voice": "nova", "text": "Hey! I am your AI speaker."},
    )

    assert response.status_code == 200
    assert response.content == b"preview-audio"
    assert response.headers["content-type"].startswith("audio/")
    assert "read-aloud-preview-nova" in response.headers["content-disposition"]


async def test_read_aloud_route_rejects_oversized_message(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(
        title="Long read aloud",
        messages=[{"sender": "ai", "type": "text", "content": "x" * (MAX_READ_ALOUD_TEXT_CHARS + 1)}],
    )

    response = await client.post(
        f"/v1/speech/read-aloud/{seeded_user.id}/{conversation['conversation_id']}/{conversation['message_ids'][0]}",
    )

    assert response.status_code == 413
    assert response.json()["detail"] == READ_ALOUD_TEXT_TOO_LONG_DETAIL
