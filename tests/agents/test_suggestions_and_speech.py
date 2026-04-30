from __future__ import annotations

from fastapi import HTTPException


async def test_generate_conversation_suggestions_route_returns_model_output(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    async def fake_generate_suggestions(req):
        return agents_service.schemas.ConversationSuggestions(
            suggestions=["Review revenue", "Compare regions"]
        )

    monkeypatch.setattr(agents_service.main, "generate_suggestions", fake_generate_suggestions)

    response = await client.post(
        "/suggestions/generate",
        headers=internal_headers,
        json={"user_input": [{"role": "user", "content": "Suggest next prompts"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"suggestions": ["Review revenue", "Compare regions"]}


async def test_generate_conversation_suggestions_route_surfaces_failures(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    async def fake_generate_suggestions(req):
        raise HTTPException(status_code=502, detail="Suggestion generation returned an invalid response.")

    monkeypatch.setattr(agents_service.main, "generate_suggestions", fake_generate_suggestions)

    response = await client.post(
        "/suggestions/generate",
        headers=internal_headers,
        json={"user_input": [{"role": "user", "content": "Suggest next prompts"}]},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "Suggestion generation returned an invalid response."


async def test_read_aloud_route_streams_audio(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    async def fake_generate_read_aloud_audio(req):
        assert req.text == "Read this"
        assert req.voice == "alloy"
        return b"audio-bytes"

    monkeypatch.setattr(agents_service.main, "generate_read_aloud_audio", fake_generate_read_aloud_audio)

    response = await client.post(
        "/speech/read-aloud",
        headers=internal_headers,
        json={"text": "Read this", "voice": "alloy"},
    )

    assert response.status_code == 200
    assert response.content == b"audio-bytes"
    assert response.headers["content-type"].startswith("audio/")
    assert "read-aloud" in response.headers["content-disposition"]


async def test_read_aloud_route_surfaces_validation_failure(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    async def fake_generate_read_aloud_audio(req):
        raise HTTPException(status_code=400, detail="Text is required for read-aloud audio.")

    monkeypatch.setattr(agents_service.main, "generate_read_aloud_audio", fake_generate_read_aloud_audio)

    response = await client.post(
        "/speech/read-aloud",
        headers=internal_headers,
        json={"text": "   ", "voice": "alloy"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Text is required for read-aloud audio."
