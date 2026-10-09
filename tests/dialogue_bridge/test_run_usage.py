"""A run's usage, folded from TOKEN_USAGE events (migrations 0032 and 0033).

Pinned: input/output/cached/reasoning tokens and model time are summed over
every model call (main agent and sub-agents, each message counted once); the
context gauge's snapshot comes from the MAIN agent's latest call only — a
sub-agent runs its own, separate context and must never overwrite it.

Plan 33: the same usage is split by (scope, agent, model) — a sub-agent named
by its TASK_SUBAGENT type, a call first seen bare and then wrapped moved to its
sub-agent, never counted twice; model and tool calls are counted from the event
log exactly as the UI counts them; and finishing a run writes one
message_usage row per group and adds the answer to its conversation's totals
and to the user's daily rollups (usage_daily, usage_daily_groups).
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

import utils.inference_runs as ir
from core.database import ConversationTable, MessageTable, MessageUsageTable, UsageDailyGroupTable, UsageDailyTable
from utils.inference_runs import InferenceRunRuntime, _mark_run_completed
from utils.run_activity import count_run_activity


def _usage(mid, *, inp, out, cached=0, reasoning=0, latency=0, context=None, window=None, model=None, compaction=None):
    value = {"message_id": mid, "input_tokens": inp, "output_tokens": out,
             "input_token_details": {"cache_read": cached}, "output_token_details": {"reasoning": reasoning},
             "latency_ms": latency}
    if context is not None:
        value.update(context_tokens=context, context_window=window, model=model, compaction_percent=compaction)
    return {"type": "CUSTOM", "name": "TOKEN_USAGE", "value": value}


def _subagent(event, task_id="task-1"):
    return {"type": "CUSTOM", "name": "SUBAGENT_EVENT", "value": {"task_id": task_id, "event": event}}


def _task(task_id, subagent_type):
    return {"type": "CUSTOM", "name": "TASK_SUBAGENT",
            "value": {"task_id": task_id, "subagent_type": subagent_type, "description": "look into it"}}


def _model_usage(mid, model, *, inp, out, cached=0, latency=0):
    event = _usage(mid, inp=inp, out=out, cached=cached, latency=latency)
    event["value"]["model"] = model
    return event


@pytest.fixture
def patch_session_local(monkeypatch, session_factory):
    """Route _finish_run's own SessionLocal() at the test database."""
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    return session_factory


def test_totals_sum_every_call_and_the_context_comes_from_the_main_agents_last_call():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_usage("m1", inp=100_000, out=500, cached=80_000, reasoning=200, latency=900,
                               context=100_000, window=272_000, model="gpt-5", compaction=92.0))
    runtime.apply_event(_subagent(_usage("s1", inp=20_000, out=300, cached=0, reasoning=0, latency=400,
                                         context=20_000, window=128_000, model="gpt-4o")))
    runtime.apply_event(_usage("m2", inp=117_000, out=700, cached=100_000, reasoning=300, latency=1_100,
                               context=117_000, window=272_000, model="gpt-5", compaction=92.0))

    assert runtime.input_tokens == 237_000 and runtime.output_tokens == 1_500
    assert runtime.cached_input_tokens == 180_000 and runtime.reasoning_tokens == 500
    assert runtime.model_latency_ms == 2_400
    assert runtime.context == {"context_tokens": 117_000, "context_window": 272_000,
                               "compaction_percent": 92.0, "model_name": "gpt-5"}


def test_a_message_seen_twice_is_counted_once_and_tier_prefixed_details_count():
    runtime = InferenceRunRuntime()
    event = _usage("m1", inp=10, out=5)
    event["value"]["input_token_details"] = {"flex_cache_read": 7}
    runtime.apply_event(event)
    runtime.apply_event(_subagent(event))           # the same message, wrapped
    assert runtime.input_tokens == 10 and runtime.cached_input_tokens == 7


def test_usage_without_metrics_leaves_the_context_empty():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_usage("m1", inp=10, out=5))
    assert runtime.context == {} and runtime.model_latency_ms == 0


def test_usage_is_split_by_scope_agent_and_model():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_model_usage("m1", "gpt-5", inp=1_000, out=10, cached=800, latency=900))
    runtime.apply_event(_task("task-1", "researcher"))
    runtime.apply_event(_subagent(_model_usage("s1", "gpt-4.1", inp=300, out=5, latency=400), "task-1"))
    runtime.apply_event(_subagent(_model_usage("s2", "gpt-4.1", inp=200, out=5, latency=100), "task-1"))
    runtime.apply_event(_subagent(_model_usage("x1", "gpt-5-mini", inp=50, out=1), "unbound-task"))
    runtime.apply_event(_model_usage("m2", "gpt-5", inp=1_200, out=20, cached=1_000, latency=1_100))

    assert runtime.usage_groups == {
        ("main", "", "gpt-5"): {"calls": 2, "input_tokens": 2_200, "cached_input_tokens": 1_800,
                                "output_tokens": 30, "reasoning_tokens": 0, "model_latency_ms": 2_000},
        ("subagent", "researcher", "gpt-4.1"): {"calls": 2, "input_tokens": 500, "cached_input_tokens": 0,
                                                "output_tokens": 10, "reasoning_tokens": 0, "model_latency_ms": 500},
        ("subagent", "sub-agent", "gpt-5-mini"): {"calls": 1, "input_tokens": 50, "cached_input_tokens": 0,
                                                  "output_tokens": 1, "reasoning_tokens": 0, "model_latency_ms": 0},
    }
    assert sum(g["input_tokens"] for g in runtime.usage_groups.values()) == runtime.input_tokens


def test_a_call_seen_bare_then_wrapped_moves_to_its_subagent_without_double_counting():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_task("task-1", "critic"))
    bare = _model_usage("s1", "gpt-5-mini", inp=40, out=4)
    runtime.apply_event(bare)
    runtime.apply_event(_subagent(bare, "task-1"))

    assert runtime.input_tokens == 40
    assert list(runtime.usage_groups) == [("subagent", "critic", "gpt-5-mini")]


def test_activity_counts_model_and_tool_calls_like_the_ui():
    events = [
        _usage("m1", inp=1, out=1),
        _usage("m1", inp=1, out=1),                       # replayed: one call
        _subagent(_usage("s1", inp=1, out=1)),
        {"type": "TOOL_CALL_START", "toolCallId": "t1"},
        _subagent({"type": "TOOL_CALL_START", "toolCallId": "t2"}),
        {"type": "RAW_SSE_EVENT", "raw_sse": 'data: {"type": "TOOL_CALL_START", "toolCallId": "t3"}'},
        {"type": "TEXT_MESSAGE_CONTENT", "delta": "hi"},
    ]
    activity = count_run_activity(events)
    assert (activity.model_calls, activity.tool_calls) == (2, 3)
    assert count_run_activity(None).model_calls == 0


async def _start_run(session_factory, conversation_id, agent):
    """One streaming answer — a conversation holds at most one at a time."""
    async with session_factory() as session:
        run = MessageTable(conversation_id=conversation_id, sender="ai", content="",
                           agent_id=agent.id, agent_name=agent.name,
                           streaming_status="running", streaming_started_at=ir._now(),
                           created_at=ir._now())
        session.add(run)
        await session.commit()
        return run.id


async def test_finishing_a_run_writes_its_breakdown_and_adds_to_the_conversation(
    patch_session_local, session_factory, seeded_user, seeded_agent
):
    async with session_factory() as session:
        conversation = ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id,
                                         agent_name=seeded_agent.name, title="Usage")
        session.add(conversation)
        await session.commit()
        conversation_id = conversation.id

    run_ids = [await _start_run(session_factory, conversation_id, seeded_agent)]
    first = InferenceRunRuntime()
    first.apply_event(_usage("m1", inp=1_000, out=10, cached=600, latency=500,
                             context=1_000, window=272_000, model="gpt-5"))
    first.apply_event(_task("task-1", "researcher"))
    first.apply_event(_subagent(_model_usage("s1", "gpt-4.1", inp=300, out=5), "task-1"))
    first.apply_event({"type": "TOOL_CALL_START", "toolCallId": "t1"})
    await _mark_run_completed(run_ids[0], first)

    run_ids.append(await _start_run(session_factory, conversation_id, seeded_agent))
    second = InferenceRunRuntime()
    second.apply_event(_usage("m2", inp=2_000, out=20, latency=700, context=2_000, window=272_000, model="gpt-5"))
    await _mark_run_completed(run_ids[1], second)

    async with session_factory() as session:
        rows = (await session.execute(
            select(MessageUsageTable).where(MessageUsageTable.message_id == run_ids[0])
        )).scalars().all()
        assert {(r.scope, r.agent_name, r.model_name, r.calls, r.input_tokens) for r in rows} == {
            ("main", seeded_agent.name, "gpt-5", 1, 1_000),
            ("subagent", "researcher", "gpt-4.1", 1, 300),
        }
        assert all(r.user_id == seeded_user.id and r.agent_id == seeded_agent.id for r in rows)

        answer = await session.get(MessageTable, run_ids[0])
        assert (answer.model_calls, answer.tool_calls) == (2, 1)

        conversation = await session.get(ConversationTable, conversation_id)
        assert conversation.usage_answers == 2
        assert conversation.usage_input_tokens == 3_300 and conversation.usage_output_tokens == 35
        assert conversation.usage_total_tokens == 3_335 and conversation.usage_cached_tokens == 600
        assert conversation.usage_model_calls == 3 and conversation.usage_tool_calls == 1
        assert conversation.usage_model_ms == 1_200
        assert (conversation.last_context_tokens, conversation.last_context_window) == (2_000, 272_000)
        assert conversation.usage_updated_at is not None

        # Both answers landed on today's row for their agent (added, not replaced).
        [day] = (await session.execute(select(UsageDailyTable))).scalars().all()
        assert (day.user_id, day.agent_id, day.answers) == (seeded_user.id, seeded_agent.id, 2)
        assert (day.input_tokens, day.model_calls, day.tool_calls, day.detailed_answers) == (3_300, 3, 1, 2)
        split = {(g.scope, g.group_name, g.model_name): g.calls
                 for g in (await session.execute(select(UsageDailyGroupTable))).scalars()}
        assert split == {("main", seeded_agent.name, "gpt-5"): 2, ("subagent", "researcher", "gpt-4.1"): 1}


async def test_a_run_that_spent_nothing_leaves_no_trace(
    patch_session_local, session_factory, seeded_user, seeded_agent
):
    async with session_factory() as session:
        conversation = ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id, title="Empty")
        session.add(conversation)
        await session.flush()
        run = MessageTable(conversation_id=conversation.id, sender="ai", content="",
                           streaming_status="running", streaming_started_at=ir._now())
        session.add(run)
        await session.commit()
        conversation_id, run_id = conversation.id, run.id

    await _mark_run_completed(run_id, InferenceRunRuntime())

    async with session_factory() as session:
        answer = await session.get(MessageTable, run_id)
        assert answer.model_calls is None and answer.tool_calls is None
        assert (await session.get(ConversationTable, conversation_id)).usage_answers == 0
        assert (await session.execute(select(MessageUsageTable))).scalars().all() == []
        assert (await session.execute(select(UsageDailyTable))).scalars().all() == []

