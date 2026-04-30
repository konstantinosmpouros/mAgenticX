from __future__ import annotations


async def test_report_then_share_list_flow(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(
        title="Shared reported answer",
        messages=[
            {"sender": "user", "type": "text", "content": "What changed?"},
            {"sender": "ai", "type": "text", "content": "A risky response."},
        ],
    )
    conversation_id = conversation["conversation_id"]
    ai_message_id = conversation["message_ids"][1]

    report_response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{conversation_id}/report",
        json={"reason": "Safety", "details": "Needs review", "messageId": ai_message_id},
    )
    share_response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{conversation_id}/share",
        json={"messageId": ai_message_id, "mode": "branch"},
    )
    share_list_response = await client.get(f"/v1/conversations/{seeded_user.id}/shares?page=1&size=10")
    public_share_response = await client.get(f"/v1/shared-conversations/{share_response.json()['token']}")

    assert report_response.status_code == 200
    assert report_response.json()["isReported"] is True
    assert share_response.status_code == 201
    assert share_response.json()["messageId"] == ai_message_id
    assert share_list_response.status_code == 200
    assert share_list_response.json()[0]["status"] == "active"
    assert public_share_response.status_code == 200
    assert public_share_response.json()["messages"][-1]["id"] == ai_message_id
