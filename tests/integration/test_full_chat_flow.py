from __future__ import annotations

import utils.titles
from router import inference as inference_router
from utils import inference_start as inference_start_utils


async def test_create_run_and_finalize_chat_flow(client, seeded_user, seeded_agent, monkeypatch):
    async def fake_get_agent_by_id(_agent_id):
        return seeded_agent

    async def fake_generate_title(_first_message):
        return "Planned onboarding"

    monkeypatch.setattr(inference_start_utils, "get_agent_by_id", fake_get_agent_by_id)
    monkeypatch.setattr(utils.titles, "generate_conversation_title", fake_generate_title)
    monkeypatch.setattr(inference_router.inference_run_manager, "launch", lambda _run_id: None)

    run_response = await client.post(
        f"/v1/inference/runs/{seeded_user.id}/start",
        json={
            "mode": "new",
            "agentId": seeded_agent.id,
            "isPrivate": False,
            "message": {
                "sender": "user",
                "type": "text",
                "content": "Help me plan a new onboarding flow.",
            },
            "enabledTools": [{"serverId": "rag", "toolName": "sql_query"}],
        },
    )

    assert run_response.status_code == 201
    run_payload = run_response.json()
    conversation_id = run_payload["detail"]["id"]
    user_message_id = run_payload["detail"]["messages"][0]["id"]
    ai_message_id = run_payload["message"]["id"]
    assert run_payload["summary"]["title"] == "Planned onboarding"
    assert [message["sender"] for message in run_payload["detail"]["messages"]] == ["user", "ai"]
    assert run_payload["detail"]["activeRunId"] == run_payload["run"]["id"]
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
