from __future__ import annotations

import utils.titles
from router import conversations as conversation_router
from router import inference as inference_router


async def test_create_run_and_finalize_chat_flow(client, seeded_user, seeded_agent, monkeypatch):
    async def fake_get_agent_by_id(_agent_id):
        return seeded_agent

    async def fake_generate_title(_first_message):
        return "Planned onboarding"

    monkeypatch.setattr(conversation_router, "get_agent_by_id", fake_get_agent_by_id)
    monkeypatch.setattr(utils.titles, "generate_conversation_title", fake_generate_title)
    monkeypatch.setattr(inference_router.inference_run_manager, "launch", lambda _run_id: None)

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

    run_response = await client.post(
        f"/v1/inference/runs/{seeded_user.id}/{conversation_id}",
        json={
            "parentMessageId": user_message_id,
            "messagePath": [user_message_id],
            "enabledTools": [{"serverId": "rag", "toolName": "sql_query"}],
        },
    )

    assert run_response.status_code == 201
    run_payload = run_response.json()
    ai_message_id = run_payload["message"]["id"]
    assert run_payload["run"]["assistantMessageId"] == ai_message_id
    assert run_payload["run"]["messagePath"] == [user_message_id, ai_message_id]
    assert run_payload["run"]["enabledTools"] == [{"server_id": "rag", "tool_name": "sql_query"}]

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
