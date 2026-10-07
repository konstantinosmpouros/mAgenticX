"""A conversation's messages come back in a total, meaningful order.

``created_at`` ties are real: a run writes the user message and its AI
placeholder in one transaction, and Postgres ``now()`` is the transaction's
start time (SQLite, which these tests use, has one-second precision — ties are
even likelier). Sorting on the timestamp alone left the order to the database;
once ``ix_messages_conversation_id_id`` existed it read rows in random-UUID
order, and the reply came back before its question about half the time
(``test_create_run_and_finalize_chat_flow`` failed intermittently in CI).

The ids below are chosen so the AI message sorts *first* by id — the exact case
that used to come back reversed.
"""
from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from core.database.models import ConversationTable, MessageTable

SAME_INSTANT = datetime(2026, 10, 8, 12, 0, 0)
AI_ID_SORTS_FIRST = "00000000-0000-0000-0000-000000000001"
USER_ID_SORTS_LAST = "ffffffff-ffff-ffff-ffff-ffffffffffff"


async def _conversation_with(session_factory, seeded_user, seeded_agent, rows):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="order",
            is_private=False,
        )
        session.add(conversation)
        await session.flush()
        for row in rows:
            session.add(MessageTable(conversation_id=conversation.id, **row))
        await session.commit()
        return conversation.id


async def _senders(session_factory, conversation_id):
    async with session_factory() as session:
        conversation = (
            await session.execute(
                select(ConversationTable)
                .options(selectinload(ConversationTable.messages))
                .where(ConversationTable.id == conversation_id)
            )
        ).scalar_one()
        return [message.sender for message in conversation.messages]


@pytest.mark.asyncio
async def test_a_tied_question_precedes_its_reply(session_factory, seeded_user, seeded_agent):
    conversation_id = await _conversation_with(
        session_factory,
        seeded_user,
        seeded_agent,
        [
            {"id": USER_ID_SORTS_LAST, "sender": "user", "content": "q", "created_at": SAME_INSTANT},
            {
                "id": AI_ID_SORTS_FIRST,
                "sender": "ai",
                "content": "a",
                "parent_message_id": USER_ID_SORTS_LAST,
                "created_at": SAME_INSTANT,
            },
        ],
    )
    assert await _senders(session_factory, conversation_id) == ["user", "ai"]


@pytest.mark.asyncio
async def test_the_timestamp_still_decides_when_it_differs(session_factory, seeded_user, seeded_agent):
    # The role only breaks ties: an older AI message stays ahead of a newer user one.
    conversation_id = await _conversation_with(
        session_factory,
        seeded_user,
        seeded_agent,
        [
            {"sender": "ai", "content": "earlier", "created_at": datetime(2026, 10, 8, 11, 0, 0)},
            {"sender": "user", "content": "later", "created_at": SAME_INSTANT},
        ],
    )
    assert await _senders(session_factory, conversation_id) == ["ai", "user"]
