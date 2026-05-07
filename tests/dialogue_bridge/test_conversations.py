from __future__ import annotations

from sqlalchemy import select

from core.database import ConversationReportTable, ConversationTable, MessageTable
from router import catalog as catalog_router
from router import conversations as conversation_router


async def _seed_branch(db_session_factory, seeded_user, seeded_agent):
    async with db_session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Branchable conversation",
            last_message_preview="Final answer",
        )
        session.add(conversation)
        await session.flush()

        user_message = MessageTable(
            conversation_id=conversation.id,
            sender="user",
            type="text",
            content="Question",
        )
        session.add(user_message)
        await session.flush()

        ai_message = MessageTable(
            conversation_id=conversation.id,
            parent_message_id=user_message.id,
            sender="ai",
            type="text",
            content="Final answer",
            reasoning_steps=["Looked up context"],
            raw_events=[{"type": "RUN_FINISHED"}],
            plan={"status": "done"},
        )
        session.add(ai_message)
        await session.commit()

        return {
            "conversation_id": conversation.id,
            "user_message_id": user_message.id,
            "ai_message_id": ai_message.id,
        }


async def _seed_sibling_branches(db_session_factory, seeded_user, seeded_agent):
    async with db_session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Conversation with branches",
            last_message_preview="Visible answer",
        )
        session.add(conversation)
        await session.flush()

        user_message = MessageTable(
            conversation_id=conversation.id,
            sender="user",
            type="text",
            content="Question",
        )
        session.add(user_message)
        await session.flush()

        visible_ai = MessageTable(
            conversation_id=conversation.id,
            parent_message_id=user_message.id,
            sender="ai",
            type="text",
            content="Visible answer",
        )
        sibling_ai = MessageTable(
            conversation_id=conversation.id,
            parent_message_id=user_message.id,
            sender="ai",
            type="text",
            content="Hidden sibling answer",
        )
        session.add_all([visible_ai, sibling_ai])
        await session.commit()

        return {
            "conversation_id": conversation.id,
            "user_message_id": user_message.id,
            "visible_ai_id": visible_ai.id,
            "sibling_ai_id": sibling_ai.id,
        }


async def test_create_conversation_persists_first_message_and_fallback_title(
    client,
    seeded_user,
    seeded_agent,
    monkeypatch,
):
    async def fake_get_agent_by_id(_agent_id):
        return seeded_agent

    async def fake_generate_title(_first_message):
        return None

    monkeypatch.setattr(conversation_router, "get_agent_by_id", fake_get_agent_by_id)
    monkeypatch.setattr(conversation_router, "generate_conversation_title", fake_generate_title)

    response = await client.post(
        f"/v1/conversations/{seeded_user.id}",
        json={
            "agentId": seeded_agent.id,
            "isPrivate": False,
            "firstMessage": {
                "sender": "user",
                "type": "text",
                "content": "This is a long first message that should become the fallback title",
            },
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["summary"]["title"] == "This is a long first message that should"
    assert payload["summary"]["lastMessage"] == "This is a long first message that should"
    assert payload["detail"]["messages"][0]["sender"] == "user"
    assert payload["detail"]["messages"][0]["content"].startswith("This is a long")


async def test_create_conversation_rejects_unknown_agent(client, seeded_user, monkeypatch):
    async def fake_get_agent_by_id(_agent_id):
        return None

    monkeypatch.setattr(conversation_router, "get_agent_by_id", fake_get_agent_by_id)

    response = await client.post(
        f"/v1/conversations/{seeded_user.id}",
        json={
            "agentId": "missing",
            "firstMessage": {"sender": "user", "type": "text", "content": "Hello"},
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown or inactive agent."


async def test_get_conversations_excludes_archived(client, seeded_user, conversation_factory):
    active = await conversation_factory(title="Active conversation")
    await conversation_factory(title="Archived conversation", is_archived=True)

    response = await client.get(f"/v1/conversations/{seeded_user.id}?page=1&size=10")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == [active["conversation_id"]]


async def test_get_archived_conversations_returns_archived_only(client, seeded_user, conversation_factory):
    archived = await conversation_factory(title="Archived conversation", is_archived=True)
    await conversation_factory(title="Active conversation")

    response = await client.get(f"/v1/conversations/{seeded_user.id}/archived?page=1&size=10")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == [archived["conversation_id"]]


async def test_archive_conversation_moves_it_out_of_default_list(
    client,
    seeded_user,
    conversation_factory,
):
    conversation = await conversation_factory(title="Archive me")

    archive_response = await client.patch(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/archive"
    )
    default_list_response = await client.get(f"/v1/conversations/{seeded_user.id}?page=1&size=10")
    archived_list_response = await client.get(f"/v1/conversations/{seeded_user.id}/archived?page=1&size=10")

    assert archive_response.status_code == 200
    assert archive_response.json()["isArchived"] is True
    assert default_list_response.json()["total"] == 0
    assert archived_list_response.json()["total"] == 1


async def test_unarchive_conversation_restores_it_to_default_list(
    client,
    seeded_user,
    conversation_factory,
):
    conversation = await conversation_factory(title="Bring me back", is_archived=True)

    unarchive_response = await client.patch(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/unarchive"
    )
    default_list_response = await client.get(f"/v1/conversations/{seeded_user.id}?page=1&size=10")
    archived_list_response = await client.get(f"/v1/conversations/{seeded_user.id}/archived?page=1&size=10")

    assert unarchive_response.status_code == 200
    assert unarchive_response.json()["isArchived"] is False
    assert default_list_response.json()["total"] == 1
    assert archived_list_response.json()["total"] == 0


async def test_report_conversation_marks_conversation_as_reported(
    client,
    seeded_user,
    conversation_factory,
    db_session_factory,
):
    conversation = await conversation_factory(title="Report conversation")

    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/report",
        json={"reason": "Bug", "details": "The conversation response was broken."},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["isReported"] is True

    async with db_session_factory() as session:
        report = await session.scalar(
            select(ConversationReportTable).where(
                ConversationReportTable.conversation_id == conversation["conversation_id"]
            )
        )
        assert report is not None
        assert report.message_id is None
        assert report.reason == "Bug"


async def test_report_specific_message_persists_target_message_id(
    client,
    seeded_user,
    conversation_factory,
    db_session_factory,
):
    conversation = await conversation_factory(
        title="Report response",
        messages=[
            {"sender": "user", "type": "text", "content": "Hello"},
            {"sender": "ai", "type": "text", "content": "Bad answer"},
        ],
    )
    target_message_id = conversation["message_ids"][-1]

    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/report",
        json={
            "reason": "Unsafe",
            "details": "This specific response should be reviewed.",
            "messageId": target_message_id,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["isReported"] is True

    async with db_session_factory() as session:
        report = await session.scalar(
            select(ConversationReportTable).where(
                ConversationReportTable.conversation_id == conversation["conversation_id"]
            )
        )
        assert report is not None
        assert report.message_id == target_message_id
        assert report.reason == "Unsafe"


async def test_report_conversation_rejects_duplicate_reports(
    client,
    seeded_user,
    conversation_factory,
):
    conversation = await conversation_factory(title="Report once")

    first_response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/report",
        json={"reason": "Bug"},
    )
    second_response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/report",
        json={"reason": "Bug"},
    )

    assert first_response.status_code == 200
    assert second_response.status_code == 409
    assert second_response.json()["detail"] == "Conversation has already been reported."


async def test_report_conversation_rejects_message_from_another_conversation(
    client,
    seeded_user,
    conversation_factory,
):
    source_conversation = await conversation_factory(
        title="Source",
        messages=[{"sender": "ai", "type": "text", "content": "Response"}],
    )
    target_conversation = await conversation_factory(title="Target")

    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{target_conversation['conversation_id']}/report",
        json={
            "reason": "Unsafe",
            "messageId": source_conversation["message_ids"][0],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Reported message does not belong to this conversation."


async def test_rename_conversation_normalizes_blank_and_long_titles(client, seeded_user, conversation_factory):
    conversation = await conversation_factory(title="Original")

    blank_response = await client.patch(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/title",
        json={"title": "   "},
    )
    long_response = await client.patch(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/title",
        json={"title": "  " + ("A" * 240) + "  "},
    )

    assert blank_response.status_code == 422
    assert long_response.status_code == 200
    assert long_response.json()["title"] == "A" * 200


async def test_fork_conversation_clones_selected_branch(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    branch = await _seed_branch(db_session_factory, seeded_user, seeded_agent)

    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{branch['conversation_id']}/fork",
        json={"messageId": branch["ai_message_id"]},
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["forkedParentId"] == branch["conversation_id"]
    assert payload["forkedMessageId"] == branch["ai_message_id"]
    assert payload["lastMessage"] == "Final answer"

    async with db_session_factory() as session:
        messages = (
            await session.execute(
                select(MessageTable)
                .where(MessageTable.conversation_id == payload["id"])
                .order_by(MessageTable.created_at.asc())
            )
        ).scalars().all()

    assert [message.sender for message in messages] == ["user", "ai"]
    assert messages[1].parent_message_id == messages[0].id
    assert messages[1].raw_events == [{"type": "RUN_FINISHED"}]


async def test_fork_conversation_rejects_unfinished_ai_message(
    client,
    seeded_user,
    conversation_factory,
):
    conversation = await conversation_factory(
        title="Unfinished",
        messages=[{"sender": "ai", "type": "text", "content": ""}],
    )

    response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{conversation['conversation_id']}/fork",
        json={"messageId": conversation["message_ids"][0]},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Cannot fork from an unfinished AI message."


async def test_share_conversation_creates_public_snapshot_and_can_be_revoked(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    branch = await _seed_branch(db_session_factory, seeded_user, seeded_agent)

    share_response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{branch['conversation_id']}/share",
        json={"messageId": branch["ai_message_id"], "mode": "full"},
    )
    public_response = await client.get(f"/v1/shared-conversations/{share_response.json()['token']}")
    list_response = await client.get(f"/v1/conversations/{seeded_user.id}/shares?page=1&size=10")
    revoke_response = await client.delete(
        f"/v1/conversations/{seeded_user.id}/{branch['conversation_id']}/share/{share_response.json()['id']}"
    )
    public_after_revoke = await client.get(f"/v1/shared-conversations/{share_response.json()['token']}")

    assert share_response.status_code == 201
    assert share_response.json()["shareMode"] == "full"
    assert public_response.status_code == 200
    assert [message["sender"] for message in public_response.json()["messages"]] == ["user", "ai"]
    assert list_response.status_code == 200
    assert list_response.json()[0]["status"] == "active"
    assert revoke_response.status_code == 204
    assert public_after_revoke.status_code == 404


async def test_full_share_exports_only_visible_branch_path(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    branch = await _seed_sibling_branches(db_session_factory, seeded_user, seeded_agent)

    share_response = await client.post(
        f"/v1/conversations/{seeded_user.id}/{branch['conversation_id']}/share",
        json={
            "messageId": branch["visible_ai_id"],
            "mode": "full",
            "branchPath": [branch["user_message_id"], branch["visible_ai_id"]],
        },
    )
    assert share_response.status_code == 201
    public_response = await client.get(f"/v1/shared-conversations/{share_response.json()['token']}")

    assert public_response.status_code == 200
    contents = [message["content"] for message in public_response.json()["messages"]]
    assert contents == ["Question", "Visible answer"]
    assert "Hidden sibling answer" not in contents


async def test_conversation_suggestions_use_recent_non_private_context(
    client,
    seeded_user,
    seeded_agent,
    conversation_factory,
    monkeypatch,
):
    await conversation_factory(
        title="Recent context",
        messages=[{"sender": "user", "type": "text", "content": "Need analytics"}],
    )

    async def fake_get_agent_by_id(_agent_id):
        return seeded_agent

    captured = {}

    async def fake_generate_conversation_suggestions(**kwargs):
        captured.update(kwargs)
        return ["Review revenue", "Compare regions"]

    monkeypatch.setattr(catalog_router, "get_agent_by_id", fake_get_agent_by_id)
    monkeypatch.setattr(catalog_router, "generate_conversation_suggestions", fake_generate_conversation_suggestions)

    response = await client.get(f"/v1/catalog/{seeded_user.id}/suggestions?agentId={seeded_agent.id}")

    assert response.status_code == 200
    assert response.json() == {"suggestions": ["Review revenue", "Compare regions"]}
    assert captured["agent_name"] == seeded_agent.name
    assert captured["recent_conversations"][0]["title"] == "Recent context"
