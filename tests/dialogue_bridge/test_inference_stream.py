from __future__ import annotations

from types import SimpleNamespace

import httpx
from fastapi import HTTPException

from router import inference as inference_router
from router import speech as speech_router


class _FakeStreamResponse:
    def __init__(self, chunks: list[bytes], status_code: int = 200):
        self._chunks = chunks
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("upstream failed", request=httpx.Request("POST", "http://agents.test"), response=httpx.Response(self.status_code))

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class _FakeJSONResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("upstream failed", request=httpx.Request("POST", "http://agents.test"), response=httpx.Response(self.status_code))

    def json(self):
        return self._payload


async def test_stream_route_forwards_sse_bytes(client, seeded_user, conversation_factory, seeded_agent, monkeypatch):
    conversation = await conversation_factory(
        title="Streaming conversation",
        messages=[{"sender": "user", "type": "text", "content": "Hello"}],
    )

    async def fake_get_agent_by_id(_agent_id):
        return seeded_agent

    monkeypatch.setattr(inference_router, "get_agent_by_id", fake_get_agent_by_id)
    monkeypatch.setattr(
        inference_router,
        "prepare_inference_history",
        lambda **kwargs: (
            [{"id": "msg-1"}],
            [{"role": "user", "content": "Hello"}],
        ),
    )

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, json, headers):
            assert method == "POST"
            assert url.endswith(f"/agents/{seeded_agent.slug}/stream")
            assert json["messages"] == [{"role": "user", "content": "Hello"}]
            return _FakeStreamResponse([b"data: hello\n\n", b"data: world\n\n"])

    monkeypatch.setattr(inference_router.httpx, "AsyncClient", FakeAsyncClient)

    response = await client.post(
        f"/v1/inference/stream/{seeded_user.id}/{conversation['conversation_id']}",
        json={"messagePath": conversation["message_ids"], "enabledTools": []},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text == "data: hello\n\ndata: world\n\n"


async def test_stream_route_returns_404_for_unknown_agent(client, seeded_user, conversation_factory, monkeypatch):
    conversation = await conversation_factory(title="Unknown agent")
    async def fake_get_agent_by_id(_agent_id):
        return None

    monkeypatch.setattr(inference_router, "get_agent_by_id", fake_get_agent_by_id)

    response = await client.post(
        f"/v1/inference/stream/{seeded_user.id}/{conversation['conversation_id']}",
        json={"messagePath": [], "enabledTools": []},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Agent metadata unavailable for this conversation"


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
