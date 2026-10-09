"""Compacting a conversation from the composer's context ring (plan 34).

Pinned:

* a compaction is recorded on the answer it follows — the answer's head moves
  to the compacted checkpoint, the summary call is booked under its own
  ``compaction`` scope (tokens and a call, never an answer), and the
  conversation's context reads the smaller figure;
* the agents service is asked against the head the answer recorded;
* every refusal: not the latest answer, a run in flight, a compaction in
  flight, an agent that does not compact, an answer with no saved state;
* while a compaction holds the conversation, no run can start on it;
* undo restores the head and the record from before, only while nothing was
  sent after; compacting twice then undoing keeps the first;
* an automatic compaction's summary call inside a run is its own usage group;
* the agents' refusal of a moved head reaches the user as a 409.
"""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

import utils.compaction as compaction_module
from core.database import ConversationTable, MessageTable, MessageUsageTable, UsageDailyGroupTable, UsageDailyTable
from utils.compaction_lock import compaction_locks
from utils.inference_runs import InferenceRunRuntime, create_inference_run_record
from utils.validators import validate_convId_full

SUMMARY_USAGE = {"calls": 1, "input_tokens": 90_000, "cached_input_tokens": 10_000,
                 "output_tokens": 1_200, "reasoning_tokens": 0, "latency_ms": 8_000}


def _compacted(checkpoint_id="cp-compacted", **overrides):
    reply = {
        "status": "compacted", "checkpoint_id": checkpoint_id, "tokens_before": 110_000, "tokens_after": 20_000,
        "freed": 90_000, "window": 272_000, "summarized_messages": 30, "kept_messages": 2,
        "summary": "The user is planning a trip.", "model": "gpt-5", "usage": SUMMARY_USAGE,
    }
    return {**reply, **overrides}


@pytest.fixture
def deep_agent(monkeypatch, seeded_agent):
    agent = SimpleNamespace(id=seeded_agent.id, slug="omni", name="Omni", type="deep agent", owner_user_id=None)

    async def get_agent_by_id(_agent_id):
        return agent

    monkeypatch.setattr(compaction_module, "get_agent_by_id", get_agent_by_id)
    return agent


@pytest.fixture
def agents(monkeypatch):
    """The agents service: replies queued per call, every request recorded."""
    calls: list[tuple[str, dict]] = []
    replies: list[dict] = []

    async def post_agents(url, body, *, action):
        calls.append((url, body))
        return replies.pop(0)

    monkeypatch.setattr(compaction_module, "_post_agents", post_agents)
    return SimpleNamespace(calls=calls, replies=replies)


async def _conversation(session_factory, user, agent, *, answer_status="completed", checkpoint=True, child=False):
    async with session_factory() as session:
        conversation = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name, title="Trip")
        session.add(conversation)
        await session.flush()
        question = MessageTable(conversation_id=conversation.id, sender="user", content="Plan my trip")
        session.add(question)
        await session.flush()
        answer = MessageTable(
            conversation_id=conversation.id, parent_message_id=question.id, sender="ai", content="Here is a plan",
            agent_id=agent.id, agent_name=agent.name, streaming_status=answer_status, is_error=False,
            input_tokens=110_000, output_tokens=900, context_tokens=110_000, context_window=272_000,
            checkpoint_thread_id="thread-1" if checkpoint else None, checkpoint_id="cp-head" if checkpoint else None,
        )
        session.add(answer)
        await session.flush()
        if child:
            session.add(MessageTable(conversation_id=conversation.id, parent_message_id=answer.id,
                                     sender="user", content="and the hotel?"))
        await session.commit()
        return conversation.id, answer.id


def _url(user, conversation_id, undo=False):
    return f"/v1/conversations/{user.id}/{conversation_id}/compact" + ("/undo" if undo else "")


async def test_compacting_records_it_on_the_answer_and_books_the_summary(
    client, session_factory, seeded_user, seeded_agent, deep_agent, agents
):
    conversation_id, answer_id = await _conversation(session_factory, seeded_user, seeded_agent)
    agents.replies.append(_compacted())

    response = await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "compacted"
    compaction = body["message"]["compaction"]
    assert compaction["trigger"] == "manual"
    assert (compaction["tokensBefore"], compaction["tokensAfter"], compaction["freed"]) == (110_000, 20_000, 90_000)
    assert compaction["summary"] == "The user is planning a trip." and compaction["undoneAt"] is None
    assert "previous" not in compaction and "checkpoint" not in str(compaction).lower()

    [(url, request)] = agents.calls
    assert url.endswith("/agents/omni/compact")
    assert (request["thread_id"], request["expected_checkpoint_id"]) == ("thread-1", "cp-head")
    assert request["config"]["context"] == {"user_id": seeded_user.id, "conversation_id": conversation_id}

    async with session_factory() as session:
        answer = await session.get(MessageTable, answer_id)
        assert answer.checkpoint_id == "cp-compacted"
        conversation = await session.get(ConversationTable, conversation_id)
        assert conversation.last_context_tokens == 20_000
        assert conversation.usage_answers == 0  # a compaction is never an answer
        assert (conversation.usage_input_tokens, conversation.usage_output_tokens) == (90_000, 1_200)
        assert (conversation.usage_model_calls, conversation.usage_model_ms) == (1, 8_000)
        [row] = (await session.execute(select(MessageUsageTable))).scalars().all()
        assert (row.message_id, row.scope, row.agent_name, row.model_name) == (answer_id, "compaction", "Compaction", "gpt-5")
        [day] = (await session.execute(select(UsageDailyTable))).scalars().all()
        assert (day.answers, day.input_tokens, day.model_calls, day.detailed_input_tokens) == (0, 90_000, 1, 90_000)
        [group] = (await session.execute(select(UsageDailyGroupTable))).scalars().all()
        assert (group.scope, group.group_name, group.calls) == ("compaction", "Compaction", 1)


async def test_nothing_to_compact_changes_nothing(client, session_factory, seeded_user, seeded_agent, deep_agent, agents):
    conversation_id, answer_id = await _conversation(session_factory, seeded_user, seeded_agent)
    agents.replies.append({"status": "nothing_to_compact"})

    response = await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})

    assert response.json() == {"status": "nothing_to_compact", "message": None}
    async with session_factory() as session:
        answer = await session.get(MessageTable, answer_id)
        assert (answer.checkpoint_id, answer.compaction) == ("cp-head", None)
    assert not await compaction_locks.held(conversation_id)


@pytest.mark.parametrize(
    ("setup", "expected"),
    [
        ({"child": True}, 409),               # not the latest answer
        ({"checkpoint": False}, 409),         # no saved agent state
        ({"answer_status": "running"}, 409),  # still streaming
    ],
)
async def test_only_the_finished_leaf_can_be_compacted(
    client, session_factory, seeded_user, seeded_agent, deep_agent, agents, setup, expected
):
    conversation_id, answer_id = await _conversation(session_factory, seeded_user, seeded_agent, **setup)

    response = await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})

    assert response.status_code == expected
    assert agents.calls == []


async def test_refusals_from_the_agent_and_the_conversation_state(
    client, session_factory, seeded_user, seeded_agent, deep_agent, agents
):
    conversation_id, answer_id = await _conversation(session_factory, seeded_user, seeded_agent)

    deep_agent.type = "langgraph agent"
    assert (await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})).status_code == 422
    deep_agent.type = "deep agent"

    assert (await client.post(_url(seeded_user, conversation_id), json={"messageId": "nope"})).status_code == 404

    assert await compaction_locks.acquire(conversation_id)
    try:
        assert (await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})).status_code == 409
    finally:
        await compaction_locks.release(conversation_id)

    async with session_factory() as session:
        answer = await session.get(MessageTable, answer_id)
        session.add(MessageTable(conversation_id=conversation_id, parent_message_id=answer.parent_message_id,
                                 sender="ai", content="", streaming_status="running"))
        await session.commit()
    assert (await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})).status_code == 409
    assert agents.calls == []


async def test_no_run_starts_while_a_compaction_holds_the_conversation(session_factory, seeded_user, seeded_agent):
    conversation_id, answer_id = await _conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as session:
        session.add(MessageTable(id="q2", conversation_id=conversation_id, parent_message_id=answer_id,
                                 sender="user", content="next"))
        await session.commit()

    assert await compaction_locks.acquire(conversation_id)
    try:
        async with session_factory() as session:
            conversation = await validate_convId_full(seeded_user.id, conversation_id, session)
            with pytest.raises(Exception) as refused:
                await create_inference_run_record(
                    db=session, user_id=seeded_user.id, conversation=conversation, parent_message_id="q2",
                    message_path=None, agent=seeded_agent, mode="send",
                )
        assert getattr(refused.value, "status_code", None) == 409
    finally:
        await compaction_locks.release(conversation_id)


async def test_undo_restores_the_head_and_compacting_twice_keeps_the_first(
    client, session_factory, seeded_user, seeded_agent, deep_agent, agents
):
    conversation_id, answer_id = await _conversation(session_factory, seeded_user, seeded_agent)
    agents.replies.extend([_compacted("cp-1"), _compacted("cp-2", freed=5_000), {"checkpoint_id": "cp-3"}])

    await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})
    second = (await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})).json()
    # The second compaction starts from what the first left.
    assert (second["message"]["compaction"]["tokensBefore"], second["message"]["compaction"]["tokensAfter"]) == (20_000, 15_000)
    assert agents.calls[1][1]["expected_checkpoint_id"] == "cp-1"

    undone = await client.post(_url(seeded_user, conversation_id, undo=True), json={"messageId": answer_id})

    assert undone.status_code == 200, undone.text
    assert agents.calls[2][0].endswith("/agents/omni/compact/undo")
    assert agents.calls[2][1]["expected_checkpoint_id"] == "cp-2"
    restored = undone.json()["compaction"]
    assert (restored["tokensAfter"], restored["undoneAt"]) == (20_000, None)  # the first compaction stands
    async with session_factory() as session:
        assert (await session.get(MessageTable, answer_id)).checkpoint_id == "cp-3"


async def test_undo_is_refused_once_something_was_sent(
    client, session_factory, seeded_user, seeded_agent, deep_agent, agents
):
    conversation_id, answer_id = await _conversation(session_factory, seeded_user, seeded_agent)
    assert (await client.post(_url(seeded_user, conversation_id, undo=True), json={"messageId": answer_id})).status_code == 409

    agents.replies.append(_compacted())
    await client.post(_url(seeded_user, conversation_id), json={"messageId": answer_id})
    async with session_factory() as session:
        session.add(MessageTable(conversation_id=conversation_id, parent_message_id=answer_id, sender="user", content="go"))
        await session.commit()

    response = await client.post(_url(seeded_user, conversation_id, undo=True), json={"messageId": answer_id})

    assert response.status_code == 409
    assert len(agents.calls) == 1


def test_an_automatic_compactions_summary_call_is_its_own_usage_group():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "CUSTOM", "name": "TOKEN_USAGE", "value": {
        "message_id": "sum-1", "input_tokens": 80_000, "output_tokens": 900, "model": "gpt-5", "purpose": "compaction"}})
    runtime.apply_event({"type": "CUSTOM", "name": "TOKEN_USAGE", "value": {
        "message_id": "m-1", "input_tokens": 30_000, "output_tokens": 400, "model": "gpt-5",
        "context_tokens": 30_000, "context_window": 272_000}})

    assert set(runtime.usage_groups) == {("compaction", "Compaction", "gpt-5"), ("main", "", "gpt-5")}
    assert runtime.context["context_tokens"] == 30_000
    assert runtime.input_tokens == 110_000


async def test_a_moved_head_reaches_the_user_as_a_conflict(monkeypatch):
    real_client = httpx.AsyncClient

    def client_factory(**kwargs):
        return real_client(transport=httpx.MockTransport(lambda request: httpx.Response(409, json={"detail": "moved"})))

    monkeypatch.setattr(compaction_module.httpx, "AsyncClient", client_factory)

    with pytest.raises(Exception) as refused:
        await compaction_module._post_agents("http://agents.test/agents/omni/compact", {}, action="compact")
    assert getattr(refused.value, "status_code", None) == 409
