from __future__ import annotations


async def test_archive_unarchive_delete_flow(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(
        title="Lifecycle conversation",
        messages=[{"sender": "user", "type": "text", "content": "Archive this later"}],
    )
    conversation_id = conversation["conversation_id"]

    active_before = await client.get(f"/v1/conversations/{seeded_user.id}?page=1&size=10")
    archive_response = await client.patch(f"/v1/conversations/{seeded_user.id}/{conversation_id}/archive")
    active_after_archive = await client.get(f"/v1/conversations/{seeded_user.id}?page=1&size=10")
    archived_after_archive = await client.get(f"/v1/conversations/{seeded_user.id}/archived?page=1&size=10")
    unarchive_response = await client.patch(f"/v1/conversations/{seeded_user.id}/{conversation_id}/unarchive")
    active_after_unarchive = await client.get(f"/v1/conversations/{seeded_user.id}?page=1&size=10")
    delete_response = await client.delete(f"/v1/conversations/{seeded_user.id}/{conversation_id}")
    details_after_delete = await client.get(f"/v1/conversations/{seeded_user.id}/{conversation_id}")

    assert active_before.status_code == 200
    assert active_before.json()["total"] == 1
    assert archive_response.status_code == 200
    assert archive_response.json()["isArchived"] is True
    assert active_after_archive.json()["total"] == 0
    assert archived_after_archive.json()["total"] == 1
    assert unarchive_response.status_code == 200
    assert unarchive_response.json()["isArchived"] is False
    assert active_after_unarchive.json()["total"] == 1
    assert delete_response.status_code == 204
    assert details_after_delete.status_code == 404
