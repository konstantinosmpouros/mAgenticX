from __future__ import annotations

import utils.titles
from router import conversations as conversation_router
from router import inference as inference_router


class _FakeStreamResponse:
    status_code = 200

    def __init__(self, chunks: list[bytes]):
        self._chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def raise_for_status(self):
        return None

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk


async def test_create_stream_and_finalize_chat_flow(client, seeded_user, seeded_agent, monkeypatch):
    async def fake_get_agent_by_id(_agent_id):
        return seeded_agent

    async def fake_generate_title(_first_message):
        return "Planned onboarding"

    monkeypatch.setattr(conversation_router, "get_agent_by_id", fake_get_agent_by_id)
    monkeypatch.setattr(utils.titles, "generate_conversation_title", fake_generate_title)
    monkeypatch.setattr(inference_router, "get_agent_by_id", fake_get_agent_by_id)

    create_response = await client.post(
        f"/v1/conversations/{seeded_user.id}",
        json={
            "agentId": seeded_agent.id,
            "isPrivate": False,
            "firstMessage": {
                "sender": "user",
                "type": "text",
                "content": "Help me plan a new onboarding flow.",
            },
        },
    )

    assert create_response.status_code == 201
    created = create_response.json()
    conversation_id = created["detail"]["id"]
    user_message_id = created["detail"]["messages"][0]["id"]
    assert created["summary"]["title"] == "Planned onboarding"

    placeholder_response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation_id}",
        json={
            "sender": "ai",
            "type": "text",
            "content": None,
            "parentMessageId": user_message_id,
        },
    )

    assert placeholder_response.status_code == 201
    ai_message_id = placeholder_response.json()["message"]["id"]

    captured_payload: dict = {}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, json, headers):
            captured_payload.update({"method": method, "url": url, "json": json, "headers": headers})
            return _FakeStreamResponse(
                [
                    b'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Draft"}\n\n',
                    b'data: {"type":"RUN_FINISHED"}\n\n',
                ]
            )

    monkeypatch.setattr(inference_router.httpx, "AsyncClient", FakeAsyncClient)

    stream_response = await client.post(
        f"/v1/inference/stream/{seeded_user.id}/{conversation_id}",
        json={
            "messagePath": [user_message_id, ai_message_id],
            "enabledTools": [{"serverId": "rag", "toolName": "sql_query"}],
        },
    )

    assert stream_response.status_code == 200
    assert stream_response.text.endswith('data: {"type":"RUN_FINISHED"}\n\n')
    assert captured_payload["method"] == "POST"
    assert captured_payload["url"].endswith(f"/agents/{seeded_agent.slug}/stream")
    assert captured_payload["json"]["messages"] == [
        {"role": "user", "content": "Help me plan a new onboarding flow."}
    ]
    assert captured_payload["json"]["config"]["tools"] == [{"tool_name": "sql_query", "server_id": "rag"}]

    finalize_response = await client.patch(
        f"/v1/messages/{seeded_user.id}/{conversation_id}/{ai_message_id}",
        json={
            "content": "Draft the flow, review with HR, and collect feedback.",
            "thinking": ["Read request", "Prepared answer"],
            "thinkingTime": 3,
            "rawEvents": [{"type": "RUN_FINISHED"}],
            "plan": {"status": "done"},
            "subagents": {},
        },
    )

    assert finalize_response.status_code == 200
    assert finalize_response.json()["summary"]["lastMessage"] == "Draft the flow, review with HR, and coll"

    details_response = await client.get(f"/v1/conversations/{seeded_user.id}/{conversation_id}")

    assert details_response.status_code == 200
    messages = details_response.json()["messages"]
    assert [message["sender"] for message in messages] == ["user", "ai"]
    assert messages[1]["parentMessageId"] == user_message_id
    assert messages[1]["rawEvents"] == [{"type": "RUN_FINISHED"}]
