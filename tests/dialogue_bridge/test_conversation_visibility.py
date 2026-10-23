"""Saving a private conversation ("Save chat"): PATCH .../visibility.

* the conversation becomes normal and lands at the top of Chats;
* its messages go back on the embedding sweeper's queue (without touching
  their own ``updated_at``), and the sweeper then embeds them;
* one-way: ``isPrivate: true`` is rejected, a second save is a 409;
* another user's conversation is a 404.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from core.database import ConversationTable, MessageTable, UserTable
from utils import embeddings as embeddings_module


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def _make_private(session_factory, conversation_id: str, *, checked: bool = True) -> None:
    """Flip a factory conversation private, back-date it, and mark its messages
    as the sweeper leaves a private chat's: checked, no vector."""
    long_ago = _utcnow() - timedelta(days=3)
    async with session_factory() as session:
        conv = await session.get(ConversationTable, conversation_id)
        conv.is_private = True
        await session.flush()
        conv.updated_at = long_ago
        rows = (await session.execute(
            select(MessageTable).where(MessageTable.conversation_id == conversation_id)
        )).scalars().all()
        for row in rows:
            row.updated_at = long_ago
            # sqlite stores the server default as the string 'false' (truthy).
            row.is_error = False
            if checked:
                row.embedding_checked_at = long_ago
        await session.commit()


def _url(user_id: str, conversation_id: str) -> str:
    return f"/v1/conversations/{user_id}/{conversation_id}/visibility"


async def test_save_private_conversation_makes_it_normal_and_top_of_chats(
    client, seeded_user, conversation_factory, session_factory
):
    older = await conversation_factory(title="Normal chat", messages=[{"content": "hi"}])
    private = await conversation_factory(
        title="Secret plans", messages=[{"content": "first"}, {"sender": "ai", "content": "answer"}]
    )
    await _make_private(session_factory, private["conversation_id"])

    before = (await client.get(f"/v1/conversations/{seeded_user.id}?page=1&size=10")).json()
    assert [item["id"] for item in before["items"]] == [older["conversation_id"]]

    response = await client.patch(_url(seeded_user.id, private["conversation_id"]), json={"isPrivate": False})

    assert response.status_code == 200
    body = response.json()
    assert body["isPrivate"] is False
    assert body["title"] == "Secret plans"

    after = (await client.get(f"/v1/conversations/{seeded_user.id}?page=1&size=10")).json()
    assert [item["id"] for item in after["items"]] == [private["conversation_id"], older["conversation_id"]]


async def test_save_requeues_messages_for_embedding_without_editing_them(
    client, seeded_user, conversation_factory, session_factory
):
    private = await conversation_factory(
        title="Secret", messages=[{"content": "remember the blue door"}, {"sender": "ai", "content": "noted"}]
    )
    await _make_private(session_factory, private["conversation_id"])
    async with session_factory() as session:
        before = {
            m.id: m.updated_at
            for m in (await session.execute(
                select(MessageTable).where(MessageTable.conversation_id == private["conversation_id"])
            )).scalars()
        }

    response = await client.patch(_url(seeded_user.id, private["conversation_id"]), json={"isPrivate": False})
    assert response.status_code == 200

    async with session_factory() as session:
        rows = (await session.execute(
            select(MessageTable).where(MessageTable.conversation_id == private["conversation_id"])
        )).scalars().all()
    assert rows and all(row.embedding_checked_at is None for row in rows)
    assert {row.id: row.updated_at for row in rows} == before

    # The sweeper now treats them like any normal conversation's messages.
    async with session_factory() as session:
        pending = (await session.execute(embeddings_module._pending_batch_query(50))).all()
    queued = [row for row in pending if row.id in before]
    assert len(queued) == 2
    assert all(embeddings_module._embeddable(row) for row in queued)


async def test_save_is_one_way_and_a_second_save_conflicts(
    client, seeded_user, conversation_factory, session_factory
):
    private = await conversation_factory(title="Secret", messages=[{"content": "x"}])
    await _make_private(session_factory, private["conversation_id"])

    make_private = await client.patch(_url(seeded_user.id, private["conversation_id"]), json={"isPrivate": True})
    assert make_private.status_code == 422

    first = await client.patch(_url(seeded_user.id, private["conversation_id"]), json={"isPrivate": False})
    second = await client.patch(_url(seeded_user.id, private["conversation_id"]), json={"isPrivate": False})
    assert first.status_code == 200
    assert second.status_code == 409


async def test_save_refuses_a_normal_conversation(client, seeded_user, conversation_factory):
    normal = await conversation_factory(title="Already normal")

    response = await client.patch(_url(seeded_user.id, normal["conversation_id"]), json={"isPrivate": False})

    assert response.status_code == 409


async def test_save_another_users_conversation_is_not_found(
    client, seeded_user, seeded_agent, session_factory
):
    async with session_factory() as session:
        other = UserTable(username="someone-else", oidc_subject="oid-someone-else", is_active=True)
        session.add(other)
        await session.flush()
        conv = ConversationTable(
            user_id=other.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Not yours",
            is_private=True,
        )
        session.add(conv)
        await session.commit()
        conversation_id = conv.id

    response = await client.patch(_url(seeded_user.id, conversation_id), json={"isPrivate": False})

    assert response.status_code == 404
    async with session_factory() as session:
        assert (await session.get(ConversationTable, conversation_id)).is_private is True
