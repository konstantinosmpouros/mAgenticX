from __future__ import annotations

import base64


async def test_add_message_with_image_attachment_updates_conversation_summary(
    client,
    seeded_user,
    conversation_factory,
):
    conversation = await conversation_factory(title="Message target")
    image_bytes = b"fake-image-bytes"

    response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}",
        json={
            "sender": "user",
            "type": "image",
            "content": "Please review this screenshot",
            "attachments": [
                {
                    "name": "screenshot.png",
                    "mime": "image/png",
                    "dataB64": base64.b64encode(image_bytes).decode("ascii"),
                    "size": len(image_bytes),
                }
            ],
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["message"]["content"] == "Please review this screenshot"
    assert payload["message"]["attachments"][0]["name"] == "screenshot.png"
    assert payload["message"]["attachments"][0]["data"] == base64.b64encode(image_bytes).decode("ascii")
    assert payload["summary"]["lastMessage"] == "Please review this screenshot"


async def test_update_ai_message_persists_streaming_metadata(
    client,
    seeded_user,
    conversation_factory,
):
    conversation = await conversation_factory(
        title="AI placeholder",
        messages=[{"sender": "ai", "type": "text", "content": ""}],
    )
    message_id = conversation["message_ids"][0]

    response = await client.patch(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}/{message_id}",
        json={
            "content": "Completed response",
            "thinking": ["Step 1", "Step 2"],
            "thinkingTime": 7,
            "error": False,
            "errorMessage": None,
            "rawEvents": [{"type": "token", "value": "Completed"}],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["message"]["content"] == "Completed response"
    assert payload["message"]["thinking"] == ["Step 1", "Step 2"]
    assert payload["message"]["thinkingTime"] == 7
    assert payload["message"]["rawEvents"] == [{"type": "token", "value": "Completed"}]
    assert payload["summary"]["lastMessage"] == "Completed response"


async def test_update_user_message_is_rejected(
    client,
    seeded_user,
    conversation_factory,
):
    conversation = await conversation_factory(
        title="User message",
        messages=[{"sender": "user", "type": "text", "content": "Original"}],
    )
    message_id = conversation["message_ids"][0]

    response = await client.patch(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}/{message_id}",
        json={"content": "Not allowed", "rawEvents": []},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Only AI messages can be updated."


async def test_like_and_dislike_toggle_message_feedback(
    client,
    seeded_user,
    conversation_factory,
):
    conversation = await conversation_factory(
        title="Feedback target",
        messages=[{"sender": "ai", "type": "text", "content": "Helpful answer"}],
    )
    message_id = conversation["message_ids"][0]

    liked_response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}/{message_id}/like"
    )
    cleared_like_response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}/{message_id}/like"
    )
    disliked_response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}/{message_id}/dislike"
    )
    cleared_dislike_response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}/{message_id}/dislike"
    )

    assert liked_response.status_code == 200
    assert liked_response.json()["liked"] is True
    assert cleared_like_response.json()["liked"] is None
    assert disliked_response.json()["liked"] is False
    assert cleared_dislike_response.json()["liked"] is None


async def test_add_message_rejects_empty_user_payload(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(title="Empty payload")

    response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}",
        json={"sender": "user", "type": "text", "content": "", "attachments": []},
    )

    assert response.status_code == 422


async def test_add_message_rejects_invalid_attachment_base64(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(title="Bad attachment")

    response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}",
        json={
            "sender": "user",
            "type": "file",
            "content": "See attached",
            "attachments": [
                {
                    "name": "broken.txt",
                    "mime": "text/plain",
                    "dataB64": "not-base64",
                    "size": 10,
                }
            ],
        },
    )

    assert response.status_code == 422


async def test_update_message_requires_content(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(
        title="AI placeholder",
        messages=[{"sender": "ai", "type": "text", "content": ""}],
    )

    response = await client.patch(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}/{conversation['message_ids'][0]}",
        json={"rawEvents": []},
    )

    assert response.status_code == 422


async def test_like_missing_message_returns_404(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(title="Feedback target")

    response = await client.post(
        f"/v1/messages/{seeded_user.id}/{conversation['conversation_id']}/missing-message/like"
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Message not found."
