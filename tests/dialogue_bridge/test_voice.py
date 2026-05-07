from __future__ import annotations

from router import voice as voice_router


async def test_realtime_voice_session_creates_empty_conversation(client, seeded_user, seeded_agent, monkeypatch):
    captured: dict = {}

    async def fake_create_realtime_session_with_agents(**kwargs):
        captured.update(kwargs)
        return {"sdp": "answer-sdp", "model": kwargs["model"], "voice": kwargs["voice"]}

    monkeypatch.setattr(voice_router, "create_realtime_session_with_agents", fake_create_realtime_session_with_agents)

    response = await client.post(
        f"/v1/voice/realtime/{seeded_user.id}/session",
        json={
            "agentId": seeded_agent.id,
            "sdp": "offer-sdp",
            "voice": "alloy",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["sdp"] == "answer-sdp"
    assert captured["sdp"] == "offer-sdp"
    assert captured["metadata"]["user_id"] == seeded_user.id
    assert captured["metadata"]["conversation_id"] is None
    assert captured["metadata"]["agent_id"] == seeded_agent.id
    assert "live voice conversation" in captured["instructions"]


async def test_realtime_voice_event_persists_transcript(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(
        title="Voice test",
        messages=[{"sender": "user", "type": "text", "content": "Existing context"}],
    )

    response = await client.post(
        f"/v1/voice/realtime/{seeded_user.id}/conversation-event",
        json={
            "conversationId": conversation["conversation_id"],
            "role": "assistant",
            "transcript": "Spoken answer",
            "itemId": "item-1",
            "responseId": "resp-1",
            "rawEvent": {"type": "response.audio_transcript.done"},
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["message"]["sender"] == "ai"
    assert payload["message"]["type"] == "audio"
    assert payload["message"]["content"] == "Spoken answer"
    assert payload["message"]["parentMessageId"] == conversation["message_ids"][-1]
    assert payload["message"]["rawEvents"] == [{"type": "response.audio_transcript.done"}]
    assert payload["summary"]["lastMessage"] == "Spoken answer"
