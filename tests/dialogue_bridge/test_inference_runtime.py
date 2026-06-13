"""Coverage for ``utils.inference_runs`` — the pure ``InferenceRunRuntime``
accumulator and the DB-backed create / cancel / finish helpers.

The live SSE streaming paths (``_do_stream`` / ``_do_resume`` and the manager
``_run`` loop) require a real network stream and are left to integration
testing. Everything here is either pure (no I/O) or DB-only.

DB helpers that open their own ``SessionLocal()`` (``_finish_run`` and friends,
``cleanup_orphaned_inference_runs``) are pointed at the per-test sqlite engine
by monkeypatching ``utils.inference_runs.SessionLocal`` with the test
``session_factory``. Functions that take an explicit ``db`` session are driven
with ``session_factory`` directly.

``test_inference_resume.py`` already covers the ``pending_interrupts``
accounting on ``apply_event``; this file extends to the remaining event types
and the lifecycle DB functions without duplicating those cases.
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from sqlalchemy.exc import IntegrityError

from core.database import ConversationTable, MessageTable
from schemas import ToolPreference
import utils.inference_runs as ir
from utils.inference_runs import (
    InferenceRunRuntime,
    SNAPSHOT_SEQ_SENTINEL,
    _fail_stale_queued_runs_for_conversation,
    _is_active_run_integrity_conflict,
    _load_message,
    _load_run,
    _message_payload_from_runtime,
    build_run_event_payload,
    build_run_out_from_message,
    cleanup_orphaned_inference_runs,
    create_inference_run_record,
    mark_run_launch_failed,
    request_run_cancel,
    stream_run_events,
    _mark_run_completed,
    _mark_run_failed,
)


@pytest.fixture
def patch_session_local(monkeypatch, session_factory):
    """Route the helpers that open their own SessionLocal() at the test DB."""
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    return session_factory


# ---------------------------------------------------------------------------
# InferenceRunRuntime.apply_event — content / thinking / tools
# ---------------------------------------------------------------------------
def test_apply_text_message_chunk_accumulates_content():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "TEXT_MESSAGE_CHUNK", "delta": "Hello "})
    runtime.apply_event({"type": "TEXT_MESSAGE_CONTENT", "delta": "world"})
    assert runtime.content == "Hello world"


def test_apply_first_chunk_closes_thinking_window():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "THINKING_START"})
    assert runtime.thinking_end == 0.0
    runtime.apply_event({"type": "TEXT_MESSAGE_CHUNK", "delta": "x"})
    assert runtime.closed_thinking_on_first_chunk is True
    assert runtime.thinking_end > 0.0


def test_apply_thinking_text_appends_thought():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": "step one"})
    runtime.apply_event({"type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": "step two"})
    assert runtime.thoughts == ["step one", "step two"]


def test_apply_tool_call_start_records_tool_thought():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "TOOL_CALL_START", "toolCallName": "search"})
    assert runtime.thoughts == ["[tool] search"]


def test_apply_tool_call_start_defaults_tool_name():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "TOOL_CALL_START"})
    assert runtime.thoughts == ["[tool] tool"]


def test_apply_thinking_start_resets_end_and_thinking_end_marks_time():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "THINKING_START"})
    start = runtime.thinking_start
    assert start > 0.0
    runtime.apply_event({"type": "THINKING_END"})
    assert runtime.thinking_end >= start


def test_apply_sets_first_event_ts_once():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": "x"})
    first = runtime.first_event_ts
    assert first > 0.0
    runtime.apply_event({"type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": "y"})
    assert runtime.first_event_ts == first


# ---------------------------------------------------------------------------
# InferenceRunRuntime.apply_event — CUSTOM events
# ---------------------------------------------------------------------------
def test_apply_plan_snapshot_sets_plan_and_appends_raw_event():
    runtime = InferenceRunRuntime()
    plan = {"items": [{"content": "do thing", "status": "pending"}]}
    runtime.apply_event({"type": "CUSTOM", "name": "PLAN_SNAPSHOT", "value": plan})
    assert runtime.plan == plan
    assert runtime.raw_events[-1]["name"] == "PLAN_SNAPSHOT"


def test_apply_task_subagent_records_task_and_raw_event():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "TEXT_MESSAGE_CHUNK", "delta": "12345"})
    runtime.apply_event({
        "type": "CUSTOM",
        "name": "TASK_SUBAGENT",
        "value": {"task_id": "t1", "subagent_type": "writer"},
    })
    tasks = runtime.subagents["tasks"]
    assert tasks[0]["task_id"] == "t1"
    assert tasks[0]["subagent_type"] == "writer"
    # the event is also folded into the durable log the UI replays
    assert runtime.raw_events[-1]["name"] == "TASK_SUBAGENT"
    assert runtime.raw_events[-1]["value"]["task_id"] == "t1"


def test_apply_subagent_event_folds_into_raw_events_without_interrupt():
    runtime = InferenceRunRuntime()
    runtime.apply_event({
        "type": "CUSTOM",
        "name": "SUBAGENT_EVENT",
        "value": {"task_id": "t1", "event": {"type": "TEXT_MESSAGE_CHUNK", "delta": "hi"}},
    })
    # SUBAGENT_EVENT envelopes land in the raw log; they no longer populate a
    # `subagents` aggregate (the UI reducer reconstructs the timeline instead).
    assert runtime.subagents is None
    assert runtime.raw_events[-1]["name"] == "SUBAGENT_EVENT"
    assert runtime.raw_events[-1]["value"]["task_id"] == "t1"
    assert runtime.pending_interrupts == 0


def test_apply_before_agent_event_appends():
    runtime = InferenceRunRuntime()
    runtime.apply_event({
        "type": "CUSTOM",
        "name": "BEFORE_AGENT_EVENT",
        "value": {"task_id": "t1", "phase": "start"},
    })
    assert runtime.subagents["beforeAgent"] == [{"task_id": "t1", "phase": "start"}]


def test_apply_unknown_custom_name_only_records_raw_event():
    runtime = InferenceRunRuntime()
    runtime.apply_event({"type": "CUSTOM", "name": "SOMETHING_ELSE", "value": {"x": 1}})
    assert runtime.subagents is None
    assert runtime.plan is None
    assert runtime.raw_events[-1]["name"] == "SOMETHING_ELSE"


# ---------------------------------------------------------------------------
# push_subagent_event
# ---------------------------------------------------------------------------
def test_push_subagent_event_accumulates_under_key():
    runtime = InferenceRunRuntime()
    runtime.push_subagent_event("tasks", {"a": 1})
    runtime.push_subagent_event("tasks", {"b": 2})
    runtime.push_subagent_event("events", {"c": 3})
    assert runtime.subagents["tasks"] == [{"a": 1}, {"b": 2}]
    assert runtime.subagents["events"] == [{"c": 3}]


# ---------------------------------------------------------------------------
# thinking_duration_seconds
# ---------------------------------------------------------------------------
def test_thinking_duration_none_before_any_event():
    runtime = InferenceRunRuntime()
    assert runtime.thinking_duration_seconds() is None


def test_thinking_duration_uses_first_event_to_end():
    runtime = InferenceRunRuntime()
    runtime.first_event_ts = 100.0
    runtime.thinking_end = 103.4
    assert runtime.thinking_duration_seconds() == 3


def test_thinking_duration_clamps_to_zero():
    runtime = InferenceRunRuntime()
    runtime.thinking_start = 200.0
    runtime.thinking_end = 199.0
    assert runtime.thinking_duration_seconds() == 0


# ---------------------------------------------------------------------------
# _message_payload_from_runtime
# ---------------------------------------------------------------------------
def test_message_payload_from_runtime_success():
    runtime = InferenceRunRuntime()
    runtime.content = "answer"
    runtime.thoughts = ["t1"]
    runtime.first_event_ts = 10.0
    runtime.thinking_end = 12.0
    runtime.raw_events = [{"type": "CUSTOM"}]
    runtime.plan = {"items": []}
    runtime.subagents = {"tasks": []}
    payload = _message_payload_from_runtime(runtime, error=False, error_message=None)
    assert payload["content"] == "answer"
    assert payload["reasoning_steps"] == ["t1"]
    assert payload["is_error"] is False
    assert payload["reasoning_time_seconds"] == 2
    assert payload["plan"] == {"items": []}


def test_message_payload_from_runtime_error():
    runtime = InferenceRunRuntime()
    payload = _message_payload_from_runtime(runtime, error=True, error_message="boom")
    assert payload["is_error"] is True
    assert payload["error_message"] == "boom"
    assert payload["reasoning_steps"] is None  # empty thoughts -> None
    assert payload["raw_events"] == []


# ---------------------------------------------------------------------------
# build_run_out_from_message
# ---------------------------------------------------------------------------
async def test_build_run_out_from_message(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Run out",
        )
        session.add(conversation)
        await session.flush()
        message = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="final",
            streaming_status="completed",
            streaming_enabled_tools=[{"server_id": "s", "tool_name": "t"}],
            raw_events=[{"type": "x"}],
        )
        session.add(message)
        await session.commit()
        await session.refresh(message)

        out = build_run_out_from_message(message, user_id=seeded_user.id)
        assert out.id == message.id
        assert out.assistantMessageId == message.id
        assert out.userId == seeded_user.id
        assert out.status == "completed"
        assert out.content == "final"
        assert out.enabledTools == [{"server_id": "s", "tool_name": "t"}]


# ---------------------------------------------------------------------------
# create_inference_run_record
# ---------------------------------------------------------------------------
async def _make_conversation_with_user_message(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Run create",
        )
        session.add(conversation)
        await session.flush()
        user_message = MessageTable(
            conversation_id=conversation.id,
            sender="user",
            type="text",
            content="hi",
        )
        session.add(user_message)
        await session.commit()
        return conversation.id, user_message.id


async def _load_conversation_with_messages(session, conversation_id, seeded_user):
    from utils.validators import validate_convId_full

    return await validate_convId_full(seeded_user.id, conversation_id, session)


async def test_create_inference_run_record_success(session_factory, seeded_user, seeded_agent):
    conv_id, parent_id = await _make_conversation_with_user_message(session_factory, seeded_user, seeded_agent)
    async with session_factory() as session:
        conversation = await _load_conversation_with_messages(session, conv_id, seeded_user)
        run = await create_inference_run_record(
            db=session,
            user_id=seeded_user.id,
            conversation=conversation,
            parent_message_id=parent_id,
            message_path=None,
            enabled_tools=[ToolPreference(server_id="srv", tool_name="tool")],
            agent=seeded_agent,
        )
        await session.commit()
        assert run.streaming_status == "queued"
        assert run.sender == "ai"
        assert run.agent_id == seeded_agent.id
        # the new run's id is appended to its own message path
        assert run.streaming_message_path[-1] == run.id
        assert conversation.active_assistant_message_id == run.id
        assert run.streaming_enabled_tools == [{"server_id": "srv", "tool_name": "tool"}]


async def test_create_inference_run_record_bad_parent_400(session_factory, seeded_user, seeded_agent):
    conv_id, _ = await _make_conversation_with_user_message(session_factory, seeded_user, seeded_agent)
    async with session_factory() as session:
        conversation = await _load_conversation_with_messages(session, conv_id, seeded_user)
        with pytest.raises(Exception) as exc:
            await create_inference_run_record(
                db=session,
                user_id=seeded_user.id,
                conversation=conversation,
                parent_message_id="not-a-real-message",
                message_path=None,
                enabled_tools=None,
                agent=seeded_agent,
            )
        assert getattr(exc.value, "status_code", None) == 400


async def test_create_inference_run_record_conflict_when_active_exists(session_factory, seeded_user, seeded_agent):
    conv_id, parent_id = await _make_conversation_with_user_message(session_factory, seeded_user, seeded_agent)
    # Seed an already-active run on the conversation.
    async with session_factory() as session:
        active = MessageTable(
            conversation_id=conv_id,
            sender="ai",
            type="text",
            content="",
            streaming_status="running",
            streaming_started_at=ir._now(),
        )
        session.add(active)
        await session.commit()

    async with session_factory() as session:
        conversation = await _load_conversation_with_messages(session, conv_id, seeded_user)
        with pytest.raises(Exception) as exc:
            await create_inference_run_record(
                db=session,
                user_id=seeded_user.id,
                conversation=conversation,
                parent_message_id=parent_id,
                message_path=None,
                enabled_tools=None,
                agent=seeded_agent,
            )
        assert getattr(exc.value, "status_code", None) == 409


async def test_create_inference_run_record_too_many_active_429(session_factory, seeded_user, seeded_agent, monkeypatch):
    monkeypatch.setattr(ir, "MAX_ACTIVE_RUNS_PER_USER", 1)
    # One active run in another conversation pushes the user to the cap.
    async with session_factory() as session:
        other = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Other",
        )
        session.add(other)
        await session.flush()
        session.add(
            MessageTable(
                conversation_id=other.id,
                sender="ai",
                type="text",
                content="",
                streaming_status="running",
                streaming_started_at=ir._now(),
            )
        )
        await session.commit()

    conv_id, parent_id = await _make_conversation_with_user_message(session_factory, seeded_user, seeded_agent)
    async with session_factory() as session:
        conversation = await _load_conversation_with_messages(session, conv_id, seeded_user)
        with pytest.raises(Exception) as exc:
            await create_inference_run_record(
                db=session,
                user_id=seeded_user.id,
                conversation=conversation,
                parent_message_id=parent_id,
                message_path=None,
                enabled_tools=None,
                agent=seeded_agent,
            )
        assert getattr(exc.value, "status_code", None) == 429


# ---------------------------------------------------------------------------
# request_run_cancel
# ---------------------------------------------------------------------------
async def test_request_run_cancel_no_live_task_marks_cancelled(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Cancel",
        )
        session.add(conversation)
        await session.flush()
        run = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="partial",
            streaming_status="running",
            streaming_started_at=ir._now(),
        )
        session.add(run)
        conversation.active_assistant_message_id = run.id
        await session.commit()
        await session.refresh(run)

        updated = await request_run_cancel(session, run)
        # No live asyncio task is registered for this run id, so it flips
        # straight to cancelled and clears the conversation's active pointer.
        assert updated.streaming_status == "cancelled"
        assert updated.streaming_completed_at is not None
        refreshed_conv = await session.get(ConversationTable, conversation.id)
        assert refreshed_conv.active_assistant_message_id is None


async def test_request_run_cancel_with_live_task_sets_cancelling(session_factory, seeded_user, seeded_agent, monkeypatch):
    monkeypatch.setattr(ir.inference_run_manager, "request_cancel", lambda run_id: True)
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Cancel live",
        )
        session.add(conversation)
        await session.flush()
        run = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="",
            streaming_status="running",
            streaming_started_at=ir._now(),
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)

        updated = await request_run_cancel(session, run)
        assert updated.streaming_status == "cancelling"
        assert updated.streaming_cancel_requested_at is not None


async def test_request_run_cancel_noop_when_terminal(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Cancel terminal",
        )
        session.add(conversation)
        await session.flush()
        run = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="done",
            streaming_status="completed",
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)

        updated = await request_run_cancel(session, run)
        assert updated.streaming_status == "completed"


# ---------------------------------------------------------------------------
# _finish_run helpers (open their own SessionLocal)
# ---------------------------------------------------------------------------
async def _seed_active_run(session_factory, seeded_user, seeded_agent, status="running", cancel_requested=False):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Finish",
        )
        session.add(conversation)
        await session.flush()
        run = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="",
            streaming_status=status,
            streaming_started_at=ir._now(),
            streaming_cancel_requested_at=ir._now() if cancel_requested else None,
        )
        session.add(run)
        conversation.active_assistant_message_id = run.id
        await session.commit()
        await session.refresh(run)
        return conversation.id, run.id


async def test_mark_run_completed_persists_content(patch_session_local, session_factory, seeded_user, seeded_agent):
    conv_id, run_id = await _seed_active_run(session_factory, seeded_user, seeded_agent)
    runtime = InferenceRunRuntime()
    runtime.content = "the final answer"
    await _mark_run_completed(run_id, runtime)

    async with session_factory() as session:
        run = await session.get(MessageTable, run_id)
        assert run.streaming_status == "completed"
        assert run.content == "the final answer"
        assert run.is_error is False
        conversation = await session.get(ConversationTable, conv_id)
        assert conversation.active_assistant_message_id is None
        assert conversation.last_message_preview


async def test_mark_run_completed_normalizes_to_cancelled_when_cancel_requested(
    patch_session_local, session_factory, seeded_user, seeded_agent
):
    conv_id, run_id = await _seed_active_run(
        session_factory, seeded_user, seeded_agent, status="cancelling", cancel_requested=True
    )
    runtime = InferenceRunRuntime()
    runtime.content = "partial"
    await _mark_run_completed(run_id, runtime)

    async with session_factory() as session:
        run = await session.get(MessageTable, run_id)
        # A "completed" verdict on a run the user asked to cancel becomes "cancelled".
        assert run.streaming_status == "cancelled"


async def test_mark_run_failed_sets_error(patch_session_local, session_factory, seeded_user, seeded_agent):
    conv_id, run_id = await _seed_active_run(session_factory, seeded_user, seeded_agent)
    await _mark_run_failed(run_id, InferenceRunRuntime(), "stream died")

    async with session_factory() as session:
        run = await session.get(MessageTable, run_id)
        assert run.streaming_status == "failed"
        assert run.is_error is True
        assert run.error_message == "stream died"
        assert run.content == "An error occurred while generating the response."


async def test_finish_run_noop_on_already_terminal(patch_session_local, session_factory, seeded_user, seeded_agent):
    conv_id, run_id = await _seed_active_run(session_factory, seeded_user, seeded_agent, status="completed")
    await _mark_run_failed(run_id, InferenceRunRuntime(), "should be ignored")
    async with session_factory() as session:
        run = await session.get(MessageTable, run_id)
        # Already terminal -> the failed write is a no-op: neither the status nor
        # the error message produced by _mark_run_failed are applied.
        assert run.streaming_status == "completed"
        assert run.error_message != "should be ignored"


async def test_mark_run_launch_failed(patch_session_local, session_factory, seeded_user, seeded_agent):
    conv_id, run_id = await _seed_active_run(session_factory, seeded_user, seeded_agent, status="queued")
    await mark_run_launch_failed(run_id)
    async with session_factory() as session:
        run = await session.get(MessageTable, run_id)
        assert run.streaming_status == "failed"
        assert run.error_message == "Inference run could not be launched."


# ---------------------------------------------------------------------------
# cleanup_orphaned_inference_runs
# ---------------------------------------------------------------------------
async def test_cleanup_orphaned_inference_runs(patch_session_local, session_factory, seeded_user, seeded_agent):
    conv_id, run_id = await _seed_active_run(session_factory, seeded_user, seeded_agent, status="running")
    await cleanup_orphaned_inference_runs()
    async with session_factory() as session:
        run = await session.get(MessageTable, run_id)
        assert run.streaming_status == "failed"
        assert run.is_error is True
        assert "service restart" in run.error_message
        conversation = await session.get(ConversationTable, conv_id)
        assert conversation.active_assistant_message_id is None


# ---------------------------------------------------------------------------
# _fail_stale_queued_runs_for_conversation
# ---------------------------------------------------------------------------
async def test_fail_stale_queued_runs(session_factory, seeded_user, seeded_agent, monkeypatch):
    monkeypatch.setattr(ir.inference_run_manager, "has_live_task", lambda run_id: False)
    stale_start = ir._now() - ir.STALE_QUEUED_RUN_AFTER - timedelta(minutes=1)
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Stale",
        )
        session.add(conversation)
        await session.flush()
        stale = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="",
            streaming_status="queued",
            streaming_started_at=stale_start,
        )
        session.add(stale)
        conversation.active_assistant_message_id = stale.id
        await session.commit()
        stale_id = stale.id
        conv_id = conversation.id

    async with session_factory() as session:
        await _fail_stale_queued_runs_for_conversation(session, conv_id)
        await session.commit()

    async with session_factory() as session:
        run = await session.get(MessageTable, stale_id)
        assert run.streaming_status == "failed"
        assert "never launched" in run.error_message
        conversation = await session.get(ConversationTable, conv_id)
        assert conversation.active_assistant_message_id is None


# ---------------------------------------------------------------------------
# _is_active_run_integrity_conflict
# ---------------------------------------------------------------------------
def _integrity_error(message: str) -> IntegrityError:
    return IntegrityError("stmt", {}, Exception(message))


def test_is_active_run_integrity_conflict_matches_unique_index():
    exc = _integrity_error("UNIQUE constraint failed: uq_messages_one_active_stream_per_conversation")
    assert _is_active_run_integrity_conflict(exc) is True


def test_is_active_run_integrity_conflict_matches_conversation_constraint():
    exc = _integrity_error("violates messages_conversation_id index")
    assert _is_active_run_integrity_conflict(exc) is True


def test_is_active_run_integrity_conflict_unrelated_returns_false():
    exc = _integrity_error("some other FK violation")
    assert _is_active_run_integrity_conflict(exc) is False


# ---------------------------------------------------------------------------
# _load_run / _load_message
# ---------------------------------------------------------------------------
async def test_load_run_and_load_message(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Load",
        )
        session.add(conversation)
        await session.flush()
        message = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="hi",
            streaming_status="completed",
        )
        session.add(message)
        await session.commit()
        message_id = message.id

    async with session_factory() as session:
        loaded_run = await _load_run(session, message_id)
        assert loaded_run is not None and loaded_run.id == message_id
        loaded_message = await _load_message(session, message_id)
        assert loaded_message is not None
        assert loaded_message.attachments == []
        assert await _load_run(session, "missing") is None


# ---------------------------------------------------------------------------
# build_run_event_payload / stream_run_events (terminal)
# ---------------------------------------------------------------------------
async def _seed_terminal_run(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Terminal payload",
        )
        session.add(conversation)
        await session.flush()
        run = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="final answer",
            streaming_status="completed",
            raw_events=[],
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        return conversation.id, run.id


async def test_build_run_event_payload(patch_session_local, session_factory, seeded_user, seeded_agent):
    conv_id, run_id = await _seed_terminal_run(session_factory, seeded_user, seeded_agent)
    async with session_factory() as session:
        payload = await build_run_event_payload(session, run_id, "snapshot")
    assert payload is not None
    assert payload["type"] == "snapshot"
    assert payload["run"]["id"] == run_id
    assert payload["message"]["content"] == "final answer"
    assert payload["summary"]["id"] == conv_id


async def test_build_run_event_payload_missing_run_returns_none(patch_session_local, session_factory):
    async with session_factory() as session:
        assert await build_run_event_payload(session, "no-such-run", "snapshot") is None


async def test_stream_run_events_terminal_yields_snapshot_sentinel(
    patch_session_local, session_factory, seeded_user, seeded_agent
):
    conv_id, run_id = await _seed_terminal_run(session_factory, seeded_user, seeded_agent)
    frames = [frame async for frame in stream_run_events(run_id)]
    assert len(frames) == 1
    seq, event = frames[0]
    assert seq == SNAPSHOT_SEQ_SENTINEL
    assert event["type"] == "snapshot"


async def _seed_running_run(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Running tail",
        )
        session.add(conversation)
        await session.flush()
        run = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="",
            streaming_status="running",
            streaming_started_at=ir._now(),
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        return run.id


def _patch_read_since(monkeypatch, events):
    async def fake_read_since(run_id, cursor, *, terminal_statuses, cancel_event=None, on_idle=None):
        for idx, event in enumerate(events):
            yield (str(idx), event)

    monkeypatch.setattr(ir.event_log, "read_since", fake_read_since)


async def test_stream_run_events_live_tail_passes_through_entry_ids(
    patch_session_local, session_factory, seeded_user, seeded_agent, monkeypatch
):
    run_id = await _seed_running_run(session_factory, seeded_user, seeded_agent)
    _patch_read_since(monkeypatch, [{"type": "update", "n": 1}])
    # `since` given → reconnect path: straight Redis replay, no live snapshot
    # frame, entry IDs from `read_since` pass through untouched.
    frames = [frame async for frame in stream_run_events(run_id, since="0")]
    assert frames == [("0", {"type": "update", "n": 1})]


async def test_fail_stale_queued_runs_skips_recent(session_factory, seeded_user, seeded_agent):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Recent queued",
        )
        session.add(conversation)
        await session.flush()
        recent = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="",
            streaming_status="queued",
            streaming_started_at=ir._now(),
        )
        session.add(recent)
        await session.commit()
        recent_id = recent.id
        conv_id = conversation.id

    async with session_factory() as session:
        await _fail_stale_queued_runs_for_conversation(session, conv_id)
        await session.commit()

    async with session_factory() as session:
        run = await session.get(MessageTable, recent_id)
        # Not past the stale cutoff -> left untouched.
        assert run.streaming_status == "queued"
