"""Per-message agent attribution at inference start.

Each AI message records the agent that produced it; ``conversations.agent_id``
is a last-used pointer. ``send`` uses the currently-selected agent while
``edit``/``retry`` inherit the original branch's agent (resolved server-side).
"""
from __future__ import annotations

import pytest_asyncio

from core.database import AgentTable, ConversationTable, MessageTable
from schemas import InferenceStartPayload, MessageIn
import utils.inference_start as inference_start_module
from utils.inference_start import start_inference_flow


@pytest_asyncio.fixture
async def second_agent(session_factory):
    async with session_factory() as session:
        agent = AgentTable(
            slug="second-agent",
            name="Second Agent",
            description="Second agent for per-message agent tests",
            icon="bot",
            is_active=True,
        )
        session.add(agent)
        await session.commit()
        await session.refresh(agent)
        return agent


def _patch_agents(monkeypatch, agents):
    by_id = {agent.id: agent for agent in agents}

    async def fake_get_agent_by_id(agent_id):
        return by_id.get(agent_id)

    monkeypatch.setattr(inference_start_module, "get_agent_by_id", fake_get_agent_by_id)


async def _seed_completed_turn(session_factory, user, agent):
    """A conversation with one finished user->AI turn stamped with ``agent``."""
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=user.id,
            agent_id=agent.id,
            agent_name=agent.name,
            title="Per-message agent",
            is_private=False,
            last_message_preview="hello",
        )
        session.add(conversation)
        await session.flush()

        user_message = MessageTable(conversation_id=conversation.id, sender="user", type="text", content="hello")
        session.add(user_message)
        await session.flush()

        ai_message = MessageTable(
            conversation_id=conversation.id,
            parent_message_id=user_message.id,
            sender="ai",
            type="text",
            content="answer from the first agent",
            agent_id=agent.id,
            agent_name=agent.name,
        )
        session.add(ai_message)
        await session.commit()
        return conversation.id, user_message.id, ai_message.id


async def test_send_stamps_selected_agent_and_updates_last_used(
    session_factory, seeded_user, seeded_agent, second_agent, monkeypatch
):
    _patch_agents(monkeypatch, [seeded_agent, second_agent])
    conversation_id, _user_message_id, ai_message_id = await _seed_completed_turn(
        session_factory, seeded_user, seeded_agent
    )

    async with session_factory() as db:
        response = await start_inference_flow(
            db=db,
            user=seeded_user,
            payload=InferenceStartPayload(
                mode="send",
                agentId=second_agent.id,
                conversationId=conversation_id,
                parentMessageId=ai_message_id,
                message=MessageIn(sender="user", type="text", content="now ask the second agent"),
            ),
        )

    # The new AI run is attributed to the currently-selected agent...
    assert response.message.agentId == second_agent.id
    assert response.message.agentName == second_agent.name
    # ...and the conversation's agent becomes the last-used pointer.
    assert response.detail.agent.id == second_agent.id


async def test_retry_reuses_original_agent(
    session_factory, seeded_user, seeded_agent, second_agent, monkeypatch
):
    _patch_agents(monkeypatch, [seeded_agent, second_agent])
    conversation_id, _user_message_id, ai_message_id = await _seed_completed_turn(
        session_factory, seeded_user, seeded_agent
    )

    async with session_factory() as db:
        response = await start_inference_flow(
            db=db,
            user=seeded_user,
            payload=InferenceStartPayload(
                mode="retry",
                agentId=second_agent.id,  # ignored — retry inherits the retried message's agent
                conversationId=conversation_id,
                targetMessageId=ai_message_id,
            ),
        )

    assert response.message.agentId == seeded_agent.id
    assert response.message.agentName == seeded_agent.name


async def test_edit_reuses_original_branch_agent(
    session_factory, seeded_user, seeded_agent, second_agent, monkeypatch
):
    _patch_agents(monkeypatch, [seeded_agent, second_agent])
    conversation_id, user_message_id, _ai_message_id = await _seed_completed_turn(
        session_factory, seeded_user, seeded_agent
    )

    async with session_factory() as db:
        response = await start_inference_flow(
            db=db,
            user=seeded_user,
            payload=InferenceStartPayload(
                mode="edit",
                agentId=second_agent.id,  # ignored — edit inherits the original reply's agent
                conversationId=conversation_id,
                targetMessageId=user_message_id,
                message=MessageIn(sender="user", type="text", content="edited prompt"),
            ),
        )

    assert response.message.agentId == seeded_agent.id
    assert response.message.agentName == seeded_agent.name
