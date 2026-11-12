"""Plan 41 (async sub-agents), the bridge half.

Pinned here:

* the ``conversation_tasks`` mirror — written from ``tasks:status`` entries,
  never across users, settled tasks get their coalesced events and their
  usage booked exactly once;
* the consumer-group plumbing on fakeredis — handled entries are acked,
  malformed ones dropped, a database failure leaves the entry pending;
* the wake-up — notice row on the task's own branch leaf, a ``send`` run on
  the same thread, ``run_started`` on the conversation channel, the agents
  service told only once the run exists or the wake-up was skipped; 409
  leaves it unnotified, 429 retries then defers, a user's Stop never wakes,
  a scheduled root keeps its wake-ups headless;
* the run-end hook — the queued message goes first, else one wake-up;
* the composer queue — 202 + one slot on a busy conversation, 409 without
  the flag or with files, cancel, sent on the leaf of the run it waited for,
  put back on a transient refusal;
* the routes and the two sockets' frame generators;
* delete / purge / export / fork / share carry the new rows and columns.

The agents service is an ``httpx.MockTransport`` (``agents_service``); Redis
is the suite's fakeredis.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

import utils.task_sockets as task_sockets
import utils.account_deletion as account_deletion
import utils.async_tasks as async_tasks
import utils.composer_queue as composer_queue
import utils.data_export as data_export
import utils.inference_runs as ir
import utils.inference_start as inference_start
import utils.runtime_reaps as runtime_reaps
import utils.task_consumers as task_consumers_module
import utils.task_wakeups as task_wakeups
from core.database import (
    ConversationTable,
    ConversationTaskTable,
    MessageTable,
    MessageUsageTable,
    ScheduledTaskTable,
    UsageDailyGroupTable,
    UserTable,
)
from core.settings import settings
from schema import MessageOut, OutboxItem, TaskStatusEntry
from utils.conversation_channel import channel_frames, channel_key, conversation_channel
from utils.inference import serialise_message_with_images_for_agent
from utils.task_consumers import TaskConsumers, handle_status_entry
from utils.task_streams import STATUS_STREAM, task_events_key, task_streams
from utils.task_wakeups import WakeOutcome, find_branch_leaf, handle_outbox_item, on_run_finished, reconcile_once

pytestmark = pytest.mark.timeout(30)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _wire(monkeypatch, session_factory, seeded_agent):
    """Point every module at the test database and stub the agent lookup."""
    for module in (ir, async_tasks, composer_queue, task_wakeups, runtime_reaps):
        monkeypatch.setattr(module, "SessionLocal", session_factory, raising=False)

    async def get_agent(_agent_id):
        return seeded_agent

    for module in (task_wakeups, composer_queue, inference_start):
        monkeypatch.setattr(module, "get_agent_by_id", get_agent)
    monkeypatch.setattr(settings.async_tasks, "wake_retry_base_seconds", 0.0)
    monkeypatch.setattr(settings.async_tasks, "read_block_ms", 100)
    monkeypatch.setattr(settings.async_tasks, "task_ws_block_ms", 100)


@pytest.fixture
def launched(monkeypatch):
    """Runs the code under test launched (never actually streamed)."""
    ids: list[str] = []
    monkeypatch.setattr(ir.inference_run_manager, "launch", ids.append)
    return ids


async def _branchy_conversation(session_factory, user, agent) -> dict[str, Any]:
    """u1 → a1 → u2 → a2 on thread T, plus an edit branch u2b → a2b on thread T2."""
    t0 = _now() - timedelta(minutes=10)
    async with session_factory() as s:
        conv = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name, title="c")
        s.add(conv)
        await s.flush()

        def msg(sender, parent, minutes, **kw):
            m = MessageTable(conversation_id=conv.id, sender=sender, content=f"{sender}-{minutes}",
                             parent_message_id=parent, created_at=t0 + timedelta(minutes=minutes), **kw)
            s.add(m)
            return m

        u1 = msg("user", None, 0)
        await s.flush()
        a1 = msg("ai", u1.id, 1, agent_id=agent.id, agent_name=agent.name, streaming_status="completed",
                 checkpoint_thread_id="T", checkpoint_id="c1")
        await s.flush()
        u2 = msg("user", a1.id, 2)
        await s.flush()
        a2 = msg("ai", u2.id, 3, agent_id=agent.id, agent_name=agent.name, streaming_status="completed",
                 checkpoint_thread_id="T", checkpoint_id="c2")
        await s.flush()
        u2b = msg("user", a1.id, 4)
        await s.flush()
        a2b = msg("ai", u2b.id, 5, agent_id=agent.id, agent_name=agent.name, streaming_status="completed",
                  checkpoint_thread_id="T2", checkpoint_id="c3")
        await s.commit()
        return {"conversation_id": conv.id, "a1": a1.id, "a2": a2.id, "a2b": a2b.id}


def _task(conv_id: str, user_id: str, **over) -> dict[str, Any]:
    task = {
        "task_id": "task-1", "conversation_id": conv_id, "user_id": user_id, "parent_task_id": None,
        "root_run_id": None, "branch_thread_id": "T", "spawned_by_message_id": None, "depth": 1,
        "name": "researcher", "subagent_path": "researcher", "description": "dig", "model": "gpt-4.1",
        "status": "running", "result_preview": None, "error": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
        "started_at": (_now() - timedelta(seconds=90)).isoformat() + "Z", "settled_at": None,
    }
    task.update(over)
    return task


def _outbox(conv_id: str, user_id: str, **over) -> OutboxItem:
    item = {
        "task_id": "task-1", "user_id": user_id, "conversation_id": conv_id, "branch_thread_id": "T",
        "root_run_id": None, "agent_slug": "test-agent", "interactive": True, "status": "success",
        "cancelled_by_user": False,
        "notification": {"content": [{"type": "text", "text": "researcher finished: 42"}],
                         "additional_kwargs": {"lc_source": "async_subagent", "task_id": "task-1"}},
    }
    item.update(over)
    return OutboxItem.model_validate(item)


async def _channel(conversation_id: str) -> list[dict[str, Any]]:
    entries = await conversation_channel._client.xrange(channel_key(conversation_id))
    return [json.loads(fields["payload"]) for _id, fields in entries]


# ---------------------------------------------------------------------------
# The mirror
# ---------------------------------------------------------------------------
async def test_a_status_entry_is_mirrored_and_announced(session_factory, seeded_user, seeded_agent):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    entry = TaskStatusEntry.model_validate(
        {"event": "TASK_STARTED", "task": _task(ids["conversation_id"], seeded_user.id)}
    )
    assert await async_tasks.apply_status_entry(entry, session_factory=session_factory) is not None

    async with session_factory() as s:
        row = await s.get(ConversationTaskTable, "task-1")
        assert (row.status, row.name, row.depth, row.user_id) == ("running", "researcher", 1, seeded_user.id)
    frames = await _channel(ids["conversation_id"])
    assert frames[-1]["type"] == "task" and frames[-1]["event"] == "TASK_STARTED"
    assert frames[-1]["task"]["task_id"] == "task-1"


async def test_a_task_naming_another_users_conversation_is_never_mirrored(session_factory, seeded_user, seeded_agent):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    entry = TaskStatusEntry.model_validate(
        {"event": "TASK_STARTED", "task": _task(ids["conversation_id"], "someone-else")}
    )
    assert await async_tasks.apply_status_entry(entry, session_factory=session_factory) is None
    async with session_factory() as s:
        assert await s.get(ConversationTaskTable, "task-1") is None
    assert await _channel(ids["conversation_id"]) == []


async def test_a_settle_captures_coalesced_events_and_books_usage_once(session_factory, seeded_user, seeded_agent):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    for delta in ("Hel", "lo"):
        await task_streams._client.xadd(task_events_key("task-1"), {"data": json.dumps(
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": delta})})
    settled = _task(
        ids["conversation_id"], seeded_user.id, status="success", spawned_by_message_id=ids["a2"],
        settled_at=_now().isoformat() + "Z", usage={"input_tokens": 100, "output_tokens": 20, "calls": 2},
    )
    entry = TaskStatusEntry.model_validate({"event": "TASK_SETTLED", "task": settled})
    await async_tasks.apply_status_entry(entry, session_factory=session_factory)
    # A duplicated entry (at-least-once delivery) books nothing more.
    await async_tasks.apply_status_entry(entry, session_factory=session_factory)

    async with session_factory() as s:
        row = await s.get(ConversationTaskTable, "task-1")
        assert row.raw_events == [{"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "Hello", "seq": 2}]
        usage = list((await s.execute(select(MessageUsageTable))).scalars())
        assert len(usage) == 1
        assert (usage[0].scope, usage[0].agent_name, usage[0].input_tokens, usage[0].calls) == (
            "subagent", "researcher", 100, 2)
        assert usage[0].message_id == ids["a2"]
        conv = await s.get(ConversationTable, ids["conversation_id"])
        assert conv.usage_input_tokens == 100 and conv.usage_answers == 0
        group = (await s.execute(select(UsageDailyGroupTable))).scalar_one()
        assert (group.scope, group.group_name, group.input_tokens) == ("subagent", "researcher", 100)

    # Re-opened and settled again with more spend: only the delta is added.
    more = {**settled, "usage": {"input_tokens": 150, "output_tokens": 30, "calls": 3}}
    await async_tasks.apply_status_entry(
        TaskStatusEntry.model_validate({"event": "TASK_SETTLED", "task": more}), session_factory=session_factory
    )
    async with session_factory() as s:
        rows = list((await s.execute(select(MessageUsageTable.input_tokens))).scalars())
        assert sorted(rows) == [50, 100]


async def test_the_list_route_serves_the_tree_to_its_owner_only(client, session_factory, seeded_user, seeded_agent):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    for task_id, parent, depth in (("t-root", None, 1), ("t-child", "t-root", 2)):
        await async_tasks.apply_status_entry(TaskStatusEntry.model_validate({"event": "TASK_STARTED", "task": _task(
            ids["conversation_id"], seeded_user.id, task_id=task_id, parent_task_id=parent, depth=depth)}),
            session_factory=session_factory)
    resp = await client.get(f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/tasks")
    assert resp.status_code == 200
    assert [(t["task_id"], t["parent_task_id"]) for t in resp.json()] == [("t-root", None), ("t-child", "t-root")]
    assert (await client.get(f"/v1/conversations/{seeded_user.id}/not-mine/tasks")).status_code == 404


# ---------------------------------------------------------------------------
# Consumers
# ---------------------------------------------------------------------------
async def test_the_status_consumer_acks_handled_and_malformed_entries(session_factory, seeded_user, seeded_agent):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    client = task_streams._client
    await task_streams.ensure_group(STATUS_STREAM)
    await client.xadd(STATUS_STREAM, {"data": json.dumps(
        {"event": "TASK_STATUS", "task": _task(ids["conversation_id"], seeded_user.id)})})
    await client.xadd(STATUS_STREAM, {"data": "not json"})

    consumers = TaskConsumers()
    entries = await task_streams.read_group(STATUS_STREAM, "c1", pending=False, count=10, block_ms=None)
    assert len(entries) == 2
    assert await consumers.process(STATUS_STREAM, entries, handle_status_entry) == 2
    assert (await client.xpending(STATUS_STREAM, "bridge"))["pending"] == 0
    async with session_factory() as s:
        assert (await s.get(ConversationTaskTable, "task-1")).status == "running"


async def test_a_database_failure_leaves_the_entry_pending(monkeypatch):
    async def down(entry, **_kw):
        raise OperationalError("SELECT 1", {}, Exception("down"))

    monkeypatch.setattr(task_consumers_module, "apply_status_entry", down)
    data = {"event": "TASK_STATUS", "task": _task("c", "u")}
    assert await handle_status_entry("1-0", data) is False


# ---------------------------------------------------------------------------
# Wake-up
# ---------------------------------------------------------------------------
def test_the_branch_leaf_is_the_newest_answer_on_the_tasks_thread():
    t0 = _now()
    rows = [
        MessageTable(id="a1", sender="ai", checkpoint_thread_id="T", created_at=t0),
        MessageTable(id="a2", sender="ai", checkpoint_thread_id="T", created_at=t0 + timedelta(seconds=5)),
        MessageTable(id="b", sender="ai", checkpoint_thread_id="T2", created_at=t0 + timedelta(seconds=9)),
        MessageTable(id="u", sender="user", created_at=t0 + timedelta(seconds=10)),
    ]
    assert find_branch_leaf(rows, "T").id == "a2"
    assert find_branch_leaf(rows, "missing") is None


async def test_a_settled_task_wakes_the_orchestrator_on_its_own_branch(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await async_tasks.apply_status_entry(TaskStatusEntry.model_validate({"event": "TASK_SETTLED", "task": _task(
        ids["conversation_id"], seeded_user.id, status="success", settled_at=_now().isoformat() + "Z")}),
        session_factory=session_factory)
    agents_service.on("POST", "/tasks/task-1/notified", httpx.Response(204))

    outcome = await handle_outbox_item(_outbox(ids["conversation_id"], seeded_user.id), session_factory)

    assert outcome is WakeOutcome.WOKEN
    assert len(launched) == 1
    async with session_factory() as s:
        notice = (await s.execute(select(MessageTable).where(MessageTable.kind == "task_notification"))).scalar_one()
        # The user is on the edit branch (a2b is newer); the wake-up still goes to T.
        assert notice.parent_message_id == ids["a2"]
        assert (notice.sender, notice.content) == ("user", "researcher finished: 42")
        assert notice.task_notice["name"] == "researcher" and notice.task_notice["duration_ms"] > 0
        run = await s.get(MessageTable, launched[0])
        assert run.parent_message_id == notice.id
        assert run.checkpoint_thread_id == "T"
        assert run.scheduled_task_id is None
        assert (await s.get(ConversationTaskTable, "task-1")).notified_at is not None
    assert len(agents_service.called("POST", "/tasks/task-1/notified")) == 1
    frames = await _channel(ids["conversation_id"])
    assert frames[-1]["type"] == "run_started" and frames[-1]["run"]["id"] == launched[0]
    assert frames[-1]["from_queue"] is False


async def test_a_busy_conversation_leaves_the_task_unnotified(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        s.add(MessageTable(conversation_id=ids["conversation_id"], sender="ai", parent_message_id=ids["a2b"],
                           streaming_status="running", streaming_started_at=_now()))
        await s.commit()
    agents_service.on("GET", "/tasks/task-1", httpx.Response(404))

    outcome = await handle_outbox_item(_outbox(ids["conversation_id"], seeded_user.id), session_factory)

    assert outcome is WakeOutcome.BUSY
    assert launched == []
    assert agents_service.called("POST", "/tasks/task-1/notified") == []
    async with session_factory() as s:
        notices = (await s.execute(select(MessageTable).where(MessageTable.kind == "task_notification"))).all()
        assert notices == []


async def test_a_run_cap_retries_then_defers(session_factory, seeded_user, seeded_agent, agents_service, launched,
                                             monkeypatch):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("GET", "/tasks/task-1", httpx.Response(404))
    monkeypatch.setattr(ir, "MAX_ACTIVE_RUNS_PER_USER", 0)
    sleeps: list[float] = []

    async def no_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(task_wakeups.asyncio, "sleep", no_sleep)
    outcome = await handle_outbox_item(_outbox(ids["conversation_id"], seeded_user.id), session_factory)
    assert outcome is WakeOutcome.DEFERRED
    assert len(sleeps) == settings.async_tasks.wake_retry_attempts
    assert agents_service.called("POST", "/tasks/task-1/notified") == []


async def test_a_user_stop_never_wakes_but_is_marked_handled(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    agents_service.on("POST", "/tasks/task-1/notified", httpx.Response(204))
    item = _outbox(ids["conversation_id"], seeded_user.id, status="cancelled", cancelled_by_user=True)
    assert await handle_outbox_item(item, session_factory) is WakeOutcome.SKIPPED
    assert launched == []
    assert len(agents_service.called("POST", "/tasks/task-1/notified")) == 1


async def test_a_task_continued_after_a_user_stop_wakes_when_it_finishes(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    # The user stops it (no wake-up, marked handled); the orchestrator continues
    # it with update_async_task; it finishes: that new outcome must wake the
    # orchestrator — whether the "running again" entry arrives or is missed.
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    conv_id = ids["conversation_id"]
    agents_service.on("POST", "/tasks/task-1/notified", httpx.Response(204))
    stopped_at = _now() - timedelta(seconds=60)

    async def entry(event, **over):
        await async_tasks.apply_status_entry(TaskStatusEntry.model_validate(
            {"event": event, "task": _task(conv_id, seeded_user.id, **over)}), session_factory=session_factory)

    await entry("TASK_SETTLED", status="cancelled", settled_at=stopped_at.isoformat() + "Z")
    stop = _outbox(conv_id, seeded_user.id, status="cancelled", cancelled_by_user=True)
    assert await handle_outbox_item(stop, session_factory) is WakeOutcome.SKIPPED
    async with session_factory() as s:
        assert (await s.get(ConversationTaskTable, "task-1")).notified_at is not None

    # The reopen entry is missed; only the new settle arrives.
    await entry("TASK_SETTLED", status="success", settled_at=_now().isoformat() + "Z")
    async with session_factory() as s:
        assert (await s.get(ConversationTaskTable, "task-1")).notified_at is None
    assert await handle_outbox_item(_outbox(conv_id, seeded_user.id), session_factory) is WakeOutcome.WOKEN
    assert len(launched) == 1


async def test_a_repeated_settle_announcement_stays_handled(
    session_factory, seeded_user, seeded_agent, agents_service
):
    # The agents service re-announces a stopped task's settle to book its usage:
    # same settle time, so the user's Stop stays handled (no wake-up).
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    conv_id = ids["conversation_id"]
    agents_service.on("POST", "/tasks/task-1/notified", httpx.Response(204))
    settled = (_now() - timedelta(seconds=5)).isoformat() + "Z"
    for _ in range(2):
        await async_tasks.apply_status_entry(TaskStatusEntry.model_validate({"event": "TASK_SETTLED", "task": _task(
            conv_id, seeded_user.id, status="cancelled", settled_at=settled)}), session_factory=session_factory)
        if _ == 0:
            await handle_outbox_item(
                _outbox(conv_id, seeded_user.id, status="cancelled", cancelled_by_user=True), session_factory)
    async with session_factory() as s:
        assert (await s.get(ConversationTaskTable, "task-1")).notified_at is not None


async def test_a_scheduled_roots_wake_up_stays_headless(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        task = ScheduledTaskTable(user_id=seeded_user.id, prompt="p", schedule_kind="interval")
        s.add(task)
        await s.flush()
        (await s.get(MessageTable, ids["a2"])).scheduled_task_id = task.id
        await s.commit()
        scheduled_id = task.id
    agents_service.on("GET", "/tasks/task-1", httpx.Response(404))
    agents_service.on("POST", "/tasks/task-1/notified", httpx.Response(204))
    item = _outbox(ids["conversation_id"], seeded_user.id, root_run_id=ids["a2"], interactive=False)
    assert await handle_outbox_item(item, session_factory) is WakeOutcome.WOKEN
    async with session_factory() as s:
        run = await s.get(MessageTable, launched[0])
        assert run.scheduled_task_id == scheduled_id
        assert ir.run_is_interactive(run) is False


async def test_the_notice_reaches_the_agent_with_its_kwargs_and_the_ui_without_them():
    notice = MessageTable(
        id="n", sender="user", content="done", kind="task_notification",
        task_notice={"task_id": "t", "name": "r", "status": "success", "duration_ms": 5,
                     "agent_kwargs": {"lc_source": "async_subagent"}},
        created_at=_now(), updated_at=_now(),
    )
    assert serialise_message_with_images_for_agent(notice) == {
        "role": "user", "content": "done", "kind": "task_notification",
        "additional_kwargs": {"lc_source": "async_subagent"},
    }
    out = MessageOut.model_validate(notice).model_dump(mode="json")
    assert out["kind"] == "task_notification"
    assert out["task_notice"] == {"task_id": "t", "name": "r", "status": "success", "duration_ms": 5}


# ---------------------------------------------------------------------------
# Run end: queued message first, else one wake-up
# ---------------------------------------------------------------------------
async def test_a_run_end_sends_the_queued_message_before_any_wake_up(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        conv = await s.get(ConversationTable, ids["conversation_id"])
        conv.queued_message = {"content": "and also this", "command": None, "agent_id": seeded_agent.id,
                               "queued_at": _now().isoformat(), "after_run_id": ids["a2b"]}
        s.add(ConversationTaskTable(task_id="task-1", conversation_id=conv.id, user_id=seeded_user.id,
                                    name="r", status="success", depth=1))
        await s.commit()

    await on_run_finished(ids["a2b"], session_factory)

    assert len(launched) == 1
    async with session_factory() as s:
        run = await s.get(MessageTable, launched[0])
        user_msg = await s.get(MessageTable, run.parent_message_id)
        assert (user_msg.content, user_msg.parent_message_id, user_msg.kind) == ("and also this", ids["a2b"], None)
        assert (await s.get(ConversationTable, ids["conversation_id"])).queued_message is None
    # The queue went first: the agents service was not even asked.
    assert agents_service.calls == []
    frames = await _channel(ids["conversation_id"])
    assert frames[-2] == {"type": "queue", "queued_message": None}
    assert frames[-1]["type"] == "run_started" and frames[-1]["from_queue"] is True


async def test_a_run_end_wakes_once_for_an_unhandled_settle(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        s.add(ConversationTaskTable(task_id="task-1", conversation_id=ids["conversation_id"], user_id=seeded_user.id,
                                    name="r", status="success", depth=1))
        await s.commit()
    unnotified = [_outbox(ids["conversation_id"], seeded_user.id).model_dump(mode="json"),
                  _outbox(ids["conversation_id"], seeded_user.id, task_id="task-2").model_dump(mode="json")]
    agents_service.on("GET", "/tasks/unnotified", httpx.Response(200, json=unnotified))
    agents_service.on("POST", "/tasks/task-1/notified", httpx.Response(204))
    agents_service.on("GET", "/tasks/task-2", httpx.Response(404))

    await on_run_finished(ids["a2"], session_factory)

    assert len(launched) == 1  # once: the run it started pulls task-2
    request = agents_service.called("GET", "/tasks/unnotified")[0]
    assert request.url.params["conversation_id"] == ids["conversation_id"]


async def test_a_run_the_user_stopped_wakes_nothing_and_holds_the_pending_results(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    # The regression: each Stop of the orchestrator was followed at once by a
    # wake-up for a result that was waiting, so it never stayed stopped.
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        s.add(ConversationTaskTable(task_id="task-1", conversation_id=ids["conversation_id"], user_id=seeded_user.id,
                                    name="r", status="success", depth=1))
        run = await s.get(MessageTable, ids["a2"])
        run.streaming_cancel_requested_at = _now()  # the Stop button
        await s.commit()
    unnotified = [_outbox(ids["conversation_id"], seeded_user.id).model_dump(mode="json")]
    agents_service.on("GET", "/tasks/unnotified", httpx.Response(200, json=unnotified))
    agents_service.on("POST", "/tasks/task-1/notified", httpx.Response(204))

    await on_run_finished(ids["a2"], session_factory)

    assert launched == []  # stays stopped
    # Held for its next run, so the reconcile loop does not wake it either.
    assert len(agents_service.called("POST", "/tasks/task-1/notified")) == 1
    async with session_factory() as s:
        assert (await s.get(ConversationTaskTable, "task-1")).notified_at is not None


async def test_a_run_end_with_nothing_to_do_never_calls_the_agents_service(
    session_factory, seeded_user, seeded_agent, agents_service, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await on_run_finished(ids["a2"], session_factory)
    assert launched == [] and agents_service.calls == []


async def test_reconcile_sends_left_behind_queues_and_unnotified_settles(
    session_factory, seeded_user, seeded_agent, agents_service, launched, monkeypatch
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        conv = await s.get(ConversationTable, ids["conversation_id"])
        conv.queued_message = {"content": "hi", "command": None, "agent_id": seeded_agent.id,
                               "queued_at": (_now() - timedelta(minutes=5)).isoformat(), "after_run_id": ids["a2b"]}
        await s.commit()
    agents_service.on("GET", "/tasks/unnotified", httpx.Response(200, json=[
        _outbox(ids["conversation_id"], seeded_user.id).model_dump(mode="json")]))
    agents_service.on("GET", "/tasks/task-1", httpx.Response(404))

    await reconcile_once(session_factory)

    # The queued send started a run, so the wake-up found the conversation busy.
    assert len(launched) == 1
    assert agents_service.called("POST", "/tasks/task-1/notified") == []


# ---------------------------------------------------------------------------
# Composer queue
# ---------------------------------------------------------------------------
async def _make_busy(session_factory, conversation_id, parent_id) -> str:
    async with session_factory() as s:
        run = MessageTable(conversation_id=conversation_id, sender="ai", parent_message_id=parent_id,
                           streaming_status="running", streaming_started_at=_now(), checkpoint_thread_id="T2")
        s.add(run)
        await s.commit()
        return run.id


def _send_body(conversation_id, parent_id, agent_id, **over):
    body = {"mode": "send", "agentId": agent_id, "conversationId": conversation_id, "parentMessageId": parent_id,
            "message": {"sender": "user", "content": "next question"}}
    body.update(over)
    return body


async def test_a_send_to_a_busy_conversation_is_queued_with_the_flag(
    client, session_factory, seeded_user, seeded_agent, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    running = await _make_busy(session_factory, ids["conversation_id"], ids["a2b"])
    url = f"/v1/inference/runs/{seeded_user.id}/start"

    refused = await client.post(url, json=_send_body(ids["conversation_id"], ids["a2b"], seeded_agent.id))
    assert refused.status_code == 409

    queued = await client.post(url, json=_send_body(ids["conversation_id"], ids["a2b"], seeded_agent.id,
                                                    queue_if_busy=True))
    assert queued.status_code == 202
    assert queued.json()["queued"] is True
    assert queued.json()["queued_message"]["content"] == "next question"
    replaced = await client.post(url, json=_send_body(ids["conversation_id"], ids["a2b"], seeded_agent.id,
                                                      queue_if_busy=True, message={"sender": "user", "content": "v2"}))
    assert replaced.status_code == 202
    async with session_factory() as s:
        stored = (await s.get(ConversationTable, ids["conversation_id"])).queued_message
        assert (stored["content"], stored["after_run_id"]) == ("v2", running)
    assert launched == []
    assert (await _channel(ids["conversation_id"]))[-1] == {
        "type": "queue", "queued_message": queued.json()["queued_message"] | {"content": "v2",
                                                                             "queued_at": stored["queued_at"]}}

    files = _send_body(ids["conversation_id"], ids["a2b"], seeded_agent.id, queue_if_busy=True, message={
        "sender": "user", "content": "x",
        "attachments": [{"name": "a.txt", "mime": "text/plain", "size": 1, "dataB64": "YQ=="}]})
    assert (await client.post(url, json=files)).status_code == 409

    cancel = await client.delete(f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}/queued-message")
    assert cancel.status_code == 204
    async with session_factory() as s:
        assert (await s.get(ConversationTable, ids["conversation_id"])).queued_message is None
    assert (await _channel(ids["conversation_id"]))[-1] == {"type": "queue", "queued_message": None}


async def test_a_queued_send_refused_for_a_transient_reason_is_put_back(
    session_factory, seeded_user, seeded_agent, launched
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    value = {"content": "q", "command": None, "agent_id": seeded_agent.id, "queued_at": _now().isoformat(),
             "after_run_id": ids["a2"]}
    async with session_factory() as s:
        (await s.get(ConversationTable, ids["conversation_id"])).queued_message = value
        await s.commit()
    await _make_busy(session_factory, ids["conversation_id"], ids["a2b"])

    sent = await composer_queue.send_queued_message(ids["conversation_id"], session_factory=session_factory)

    assert sent is False and launched == []
    async with session_factory() as s:
        assert (await s.get(ConversationTable, ids["conversation_id"])).queued_message == value


# ---------------------------------------------------------------------------
# Task actions and sockets
# ---------------------------------------------------------------------------
async def _mirror(session_factory, conv_id, user_id, **over):
    await async_tasks.apply_status_entry(TaskStatusEntry.model_validate(
        {"event": "TASK_STARTED", "task": _task(conv_id, user_id, **over)}), session_factory=session_factory)


async def test_a_conversation_with_working_tasks_reads_busy_until_they_settle(
    client, session_factory, seeded_user, seeded_agent
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    conv_id = ids["conversation_id"]
    await _mirror(session_factory, conv_id, seeded_user.id, task_id="t-old", spawned_by_message_id=ids["a2"],
                  status="success", settled_at=_now().isoformat())
    await _mirror(session_factory, conv_id, seeded_user.id, task_id="t-live", spawned_by_message_id=ids["a2b"])

    async with session_factory() as s:  # listed in the sidebar's Chats
        row = await s.get(ConversationTable, conv_id)
        row.is_private, row.is_archived = False, False
        await s.commit()
    listed = await client.get(f"/v1/conversations/{seeded_user.id}")
    summary = next(c for c in listed.json()["items"] if c["id"] == conv_id)
    assert summary["hasActiveTasks"] is True and summary["isStreaming"] is False
    detail = (await client.get(f"/v1/conversations/{seeded_user.id}/{conv_id}")).json()
    assert detail["hasActiveTasks"] is True
    assert detail["activeTaskMessageId"] == ids["a2b"]  # the working task's answer, not the settled one's
    active = await client.get(f"/v1/tasks/{seeded_user.id}/active-conversations")
    assert active.status_code == 200 and active.json() == {"conversationIds": [conv_id]}

    await async_tasks.apply_status_entry(TaskStatusEntry.model_validate({"event": "TASK_SETTLED", "task": _task(
        conv_id, seeded_user.id, task_id="t-live", spawned_by_message_id=ids["a2b"], status="success",
        settled_at=_now().isoformat())}), session_factory=session_factory)
    detail = (await client.get(f"/v1/conversations/{seeded_user.id}/{conv_id}")).json()
    assert detail["hasActiveTasks"] is False and detail["activeTaskMessageId"] is None
    assert (await client.get(f"/v1/tasks/{seeded_user.id}/active-conversations")).json() == {"conversationIds": []}


async def test_the_busy_list_is_the_callers_own(client, session_factory, seeded_user, seeded_agent):
    async with session_factory() as s:
        other = UserTable(username="u-other", oidc_subject="oid-other", is_active=True)
        s.add(other)
        await s.commit()
    theirs = await _branchy_conversation(session_factory, other, seeded_agent)
    await _mirror(session_factory, theirs["conversation_id"], other.id)
    # Whatever the path says, the list is the signed-in user's.
    for path_user in (seeded_user.id, other.id):
        resp = await client.get(f"/v1/tasks/{path_user}/active-conversations")
        assert resp.status_code == 200 and resp.json() == {"conversationIds": []}


async def test_stop_proxies_to_the_agents_service_for_the_owner_only(
    client, session_factory, seeded_user, seeded_agent, agents_service
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await _mirror(session_factory, ids["conversation_id"], seeded_user.id)
    cancelled = _task(ids["conversation_id"], seeded_user.id, status="cancelled", settled_at=_now().isoformat())
    agents_service.on("POST", "/tasks/task-1/cancel", httpx.Response(200, json=cancelled))

    resp = await client.post(f"/v1/tasks/{seeded_user.id}/task-1/cancel")
    assert resp.status_code == 200 and resp.json()["status"] == "cancelled"
    sent = json.loads(agents_service.called("POST", "/tasks/task-1/cancel")[0].content)
    assert sent == {"user_id": seeded_user.id, "reason": "user"}
    async with session_factory() as s:
        assert (await s.get(ConversationTaskTable, "task-1")).status == "cancelled"

    # Not mirrored and not the user's upstream either: 404, nothing proxied.
    agents_service.on("GET", "/tasks/other", httpx.Response(404))
    assert (await client.post(f"/v1/tasks/{seeded_user.id}/other/cancel")).status_code == 404
    assert agents_service.called("POST", "/tasks/other/cancel") == []


async def test_an_approval_needs_its_interrupt_and_goes_keyed_by_it(
    client, session_factory, seeded_user, seeded_agent, agents_service
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await _mirror(session_factory, ids["conversation_id"], seeded_user.id, status="waiting")
    agents_service.on("POST", "/tasks/task-1/resume", httpx.Response(
        200, json=_task(ids["conversation_id"], seeded_user.id)))
    url = f"/v1/tasks/{seeded_user.id}/task-1/resume"

    assert (await client.post(url, json={"decision": "approve"})).status_code == 422
    resp = await client.post(url, json={"decision": "approve", "interruptId": "int-1"})
    assert resp.status_code == 200
    sent = json.loads(agents_service.called("POST", "/tasks/task-1/resume")[0].content)
    assert sent["user_id"] == seeded_user.id
    assert sent["decisions"] == {"int-1": {"decision": "approve", "reason": None, "value": None, "decisions": None}}

    # The drill-down learns the approval was answered: the same resolved
    # marker a run's log gets, in the task's own event stream.
    entries = await task_streams._client.xrange(task_events_key("task-1"))
    markers = [json.loads(fields["data"]) for _id, fields in entries]
    assert [m["name"] for m in markers] == ["BRIDGE_HITL_RESOLVED"]
    assert markers[0]["value"]["interrupt_id"] == "int-1"
    assert markers[0]["value"]["decision"] == "approve"


async def test_the_task_socket_serves_a_settled_node_from_the_mirror(session_factory, seeded_user, seeded_agent):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await _mirror(session_factory, ids["conversation_id"], seeded_user.id, status="success")
    async with session_factory() as s:
        (await s.get(ConversationTaskTable, "task-1")).raw_events = [{"type": "RUN_STARTED"}]
        await s.commit()
    frames = [f async for f in async_tasks.stream_task_events(seeded_user.id, "task-1", None,
                                                               session_factory=session_factory)]
    assert [f["type"] for f in frames] == ["snapshot", "terminal"]
    assert frames[0]["events"] == [{"type": "RUN_STARTED"}] and frames[1]["status"] == "success"
    assert [f async for f in async_tasks.stream_task_events("intruder", "task-1", None,
                                                            session_factory=session_factory)] == []


async def test_the_task_socket_tails_a_live_node_until_it_settles(session_factory, seeded_user, seeded_agent):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await _mirror(session_factory, ids["conversation_id"], seeded_user.id)
    await task_streams._client.xadd(task_events_key("task-1"), {"data": json.dumps({"type": "STEP"})})
    frames: list[dict[str, Any]] = []

    async def read():
        async for frame in async_tasks.stream_task_events(seeded_user.id, "task-1", None,
                                                          session_factory=session_factory):
            frames.append(frame)
            if frame["type"] == "event" and frame["event"]["type"] == "STEP":
                async with session_factory() as s:
                    (await s.get(ConversationTaskTable, "task-1")).status = "error"
                    await s.commit()
                await task_streams._client.xadd(task_events_key("task-1"), {"data": json.dumps({"type": "LAST"})})

    await asyncio.wait_for(read(), timeout=10)
    assert [f["type"] for f in frames] == ["snapshot", "event", "event", "terminal"]
    # A live snapshot carries the task but no `events`: the log follows as frames.
    assert "task" in frames[0] and "events" not in frames[0]
    assert [f["event"]["type"] for f in frames if f["type"] == "event"] == ["STEP", "LAST"]
    assert frames[-1] == {"type": "terminal", "status": "error"}


async def test_the_conversation_socket_starts_with_the_queue_then_tails_frames(seeded_user):
    await conversation_channel.publish("conv-1", {"type": "queue", "queued_message": None, "marker": 0})
    frames = channel_frames("conv-1", None, None)
    assert await anext(frames) == {"type": "queue", "queued_message": None}
    # Published after the subscribe: tailed. The one before it is history.
    await conversation_channel.publish("conv-1", {"type": "queue", "queued_message": None, "marker": 1})
    tailed = await asyncio.wait_for(anext(frames), timeout=5)
    assert tailed["marker"] == 1 and tailed["seq"]
    await frames.aclose()


# ---------------------------------------------------------------------------
# Delete, purge, export, fork
# ---------------------------------------------------------------------------
async def test_deleting_a_conversation_stops_its_tasks_and_reaps_their_threads(
    client, session_factory, seeded_user, seeded_agent, agents_service
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await _mirror(session_factory, ids["conversation_id"], seeded_user.id)
    agents_service.on("POST", "/tasks/cancel-scope", httpx.Response(200, json={"cancelled": 1}))
    reap = f"/users/{seeded_user.id}/conversations/{ids['conversation_id']}/reap"
    agents_service.on("POST", reap, httpx.Response(204))
    sources = f"/users/{seeded_user.id}/conversations/{ids['conversation_id']}/sources"
    agents_service.on("DELETE", sources, httpx.Response(204))

    assert (await client.delete(f"/v1/conversations/{seeded_user.id}/{ids['conversation_id']}")).status_code == 204

    scope = json.loads(agents_service.called("POST", "/tasks/cancel-scope")[0].content)
    assert scope == {"user_id": seeded_user.id, "conversation_id": ids["conversation_id"]}
    assert "task-1" in json.loads(agents_service.called("POST", reap)[0].content)["thread_ids"]
    assert len(agents_service.called("DELETE", sources)) == 1
    async with session_factory() as s:
        assert await s.get(ConversationTaskTable, "task-1") is None


async def test_the_purge_stops_the_users_tasks_and_drops_their_threads(
    session_factory, seeded_user, seeded_agent, monkeypatch
):
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await _mirror(session_factory, ids["conversation_id"], seeded_user.id)
    monkeypatch.setattr(account_deletion, "SessionLocal", session_factory)
    calls: list[tuple[str, Any]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path, json.loads(request.content or b"null")))
        if request.url.path.endswith("/cancel-scope"):
            return httpx.Response(200, json={"cancelled": 2})
        return httpx.Response(200, json={"deleted": 1})

    real = httpx.AsyncClient
    monkeypatch.setattr(account_deletion.httpx, "AsyncClient",
                        lambda *a, **k: real(transport=httpx.MockTransport(handle), timeout=k.get("timeout")))
    counts: dict[str, Any] = {}
    await account_deletion._step_agent_tasks(seeded_user.id, "d", counts)
    await account_deletion._step_agent_threads(seeded_user.id, "d", counts)
    await account_deletion._delete_conversation_batch([ids["conversation_id"]], "d", counts)

    assert calls[0] == ("/tasks/cancel-scope", {"user_id": seeded_user.id})
    assert counts["agent_tasks_cancelled"] == 2
    assert any("task-1" in body["thread_ids"] for path, body in calls if path.endswith("/purge/threads"))
    assert counts["conversation_tasks"] == 1


async def test_the_export_lists_tasks_and_the_notice_columns(session_factory, seeded_user, seeded_agent, monkeypatch):
    monkeypatch.setattr(data_export, "SessionLocal", session_factory)
    ids = await _branchy_conversation(session_factory, seeded_user, seeded_agent)
    await _mirror(session_factory, ids["conversation_id"], seeded_user.id)
    rows = [row async for row in data_export._all_conversation_tasks(seeded_user.id)]
    assert [(r["task_id"], r["name"]) for r in rows] == [("task-1", "researcher")]
    assert "raw_events" not in rows[0]
    messages = [row async for row in data_export._all_messages(seeded_user.id)]
    assert {"kind", "task_notice"} <= set(messages[0])



# ---------------------------------------------------------------------------
# The socket handshakes
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("path", ["/v1/tasks/{user}/task-1/ws", "/v1/conversations/{user}/conv-1/ws"])
def test_the_task_sockets_refuse_without_a_session(app, seeded_user, path):
    # No `with`: the app's lifespan (migrations, loops) must not run here.
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(path.format(user=seeded_user.id)):
            pass
    assert refused.value.code == 4401


@pytest.mark.parametrize("path", ["/v1/tasks/{user}/nope/ws", "/v1/conversations/{user}/nope/ws"])
def test_the_task_sockets_refuse_what_the_user_does_not_own(app, seeded_user, monkeypatch, path):
    async def signed_in(_cookies, user_id):
        return seeded_user

    async def allowed(_websocket, _user_id):
        return True

    class _NoRows:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, *_a, **_k):
            return _Result()

    class _Result:
        def scalar_one_or_none(self):
            return None

    monkeypatch.setattr(task_sockets, "authenticate_websocket_user", signed_in)
    monkeypatch.setattr(task_sockets, "allow_ws_connect", allowed)
    monkeypatch.setattr(task_sockets, "SessionLocal", _NoRows)
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(path.format(user=seeded_user.id)):
            pass
    assert refused.value.code == 4404
