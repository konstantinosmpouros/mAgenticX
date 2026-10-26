"""Parallel approvals on the bridge: every decision applied, none lost.

The incident: three parallel sub-agents each stopped at an approval gate, the
user approved all three within a second, every POST returned 200 — and the
third decision was silently overwritten by the second in the run's single
resume slot, leaving the run paused on an approval with no decision.

These tests drive the real ``InferenceRunManager._run`` against a seeded run,
with the agents service simulated at the ``_do_stream`` / ``_do_resume`` seam
(the HTTP body ``_do_resume`` sends is checked separately). The simulated
agents service behaves like the real one: it keeps its own set of pending
interrupts, refuses a decision for one that is not pending, and re-surfaces
the interrupts still waiting at the end of every resume leg.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
import pytest_asyncio

import utils.inference_runs as ir
from core.cache import client as cache_client
from core.database import ConversationTable, MessageTable
from core.settings import settings
from utils import event_log as event_log_module
from utils.hitl_decisions import EXPIRED_DECISION, HitlDecisionQueue, ResumeOutcome, StaleDecisions
from utils.inference_runs import inference_run_manager

IDS = ("int-helper-1", "int-helper-2", "int-helper-3")


def _decision(interrupt_id: str | None, decision: str = "approve", **extra: Any) -> dict[str, Any]:
    return {"interrupt_id": interrupt_id, "decision": decision, "reason": None, "value": None, "decisions": None, **extra}


# ---------------------------------------------------------------------------
# HitlDecisionQueue
# ---------------------------------------------------------------------------
def test_decisions_queue_per_interrupt_and_come_out_in_pending_order():
    queue = HitlDecisionQueue()
    for interrupt_id in ("int-helper-3", "int-helper-1", "int-helper-2"):
        assert queue.offer(_decision(interrupt_id), list(IDS))[0] is ResumeOutcome.ACCEPTED
    assert [token for token, _ in queue.take_ready(list(IDS))] == list(IDS)
    assert len(queue) == 0


def test_without_batching_one_decision_goes_out_per_take_and_the_rest_wait():
    queue = HitlDecisionQueue()
    for interrupt_id in IDS:
        queue.offer(_decision(interrupt_id), list(IDS))
    assert [t for t, _ in queue.take_ready(list(IDS), batch=False)] == ["int-helper-1"]
    assert [t for t, _ in queue.take_ready(list(IDS[1:]), batch=False)] == ["int-helper-2"]
    assert len(queue) == 1


def test_a_decision_for_an_interrupt_that_is_not_pending_is_refused():
    queue = HitlDecisionQueue()
    assert queue.offer(_decision("int-made-up"), list(IDS))[0] is ResumeOutcome.UNKNOWN_INTERRUPT
    assert queue.offer(_decision("int-made-up"), [])[0] is ResumeOutcome.NOT_PAUSED
    assert len(queue) == 0


def test_an_identical_repeat_is_idempotent_and_a_different_one_conflicts():
    queue = HitlDecisionQueue()
    queue.offer(_decision("int-helper-1"), list(IDS))
    assert queue.offer(_decision("int-helper-1"), list(IDS))[0] is ResumeOutcome.ALREADY_RECEIVED
    assert queue.offer(_decision("int-helper-1", "reject"), list(IDS))[0] is ResumeOutcome.CONFLICTING_DECISION
    assert len(queue.take_ready(list(IDS))) == 1
    # Still known once dispatched (no longer pending on the bridge's side).
    assert queue.offer(_decision("int-helper-1"), list(IDS[1:]))[0] is ResumeOutcome.ALREADY_RECEIVED
    assert queue.offer(_decision("int-helper-1", "reject"), list(IDS[1:]))[0] is ResumeOutcome.CONFLICTING_DECISION


def test_a_decision_without_an_interrupt_id_answers_the_first_undecided_one():
    queue = HitlDecisionQueue()
    queue.offer(_decision("int-helper-1"), list(IDS))
    outcome, token = queue.offer(_decision(None), list(IDS))
    assert (outcome, token) == (ResumeOutcome.ACCEPTED, "int-helper-2")
    # An id-less decision cannot be keyed for a batch: it goes out on its own.
    assert [t for t, _ in queue.take_ready(list(IDS))] == ["int-helper-1"]
    queue.offer(_decision("int-helper-3"), list(IDS[1:]))
    assert queue.offer(_decision(None), list(IDS[1:]))[0] is ResumeOutcome.NOTHING_UNDECIDED


def test_a_second_pause_on_an_answered_interrupt_takes_a_new_decision():
    queue = HitlDecisionQueue()
    queue.offer(_decision("int-helper-1"), list(IDS))
    queue.take_ready(list(IDS))
    queue.forget_answered(["int-helper-1"])
    assert queue.offer(_decision("int-helper-1", "reject"), list(IDS))[0] is ResumeOutcome.ACCEPTED


def test_refusals_carry_a_message_for_the_409():
    for outcome in ResumeOutcome:
        assert bool(outcome.detail) is not outcome.accepted
    assert "paused" in ResumeOutcome.NOT_PAUSED.detail.lower()


# ---------------------------------------------------------------------------
# The run, end to end on the manager
# ---------------------------------------------------------------------------
class FakeAgents:
    """The agents service: three interrupts surface on the first leg."""

    def __init__(self, leg_seconds: float = 0.05) -> None:
        self.pending = list(IDS)
        self.legs: list[list[str]] = []
        self.refused: list[list[str]] = []
        self.leg_seconds = leg_seconds
        self.leg_running = asyncio.Event()

    @staticmethod
    def _interrupts(ids: list[str]) -> list[dict[str, Any]]:
        events = []
        for interrupt_id in ids:
            hitl = {
                "type": "CUSTOM",
                "name": "HITL_INTERRUPT",
                "value": {"interrupt": {"id": interrupt_id, "value": {"action_requests": [{"name": "edit_file"}]}}},
            }
            # Delivered twice, like a sub-agent's interrupt: wrapped and bare.
            events.append({"type": "CUSTOM", "name": "SUBAGENT_EVENT", "value": {"task_id": f"task-{interrupt_id}", "event": hitl}})
            events.append(hitl)
        return events

    async def _emit(self, manager, run_id, run_meta, runtime, events) -> None:
        applied = [e for e in (runtime.apply_event(event) for event in events) if e is not None]
        await manager._publish_delta(run_id, run_meta, runtime, applied)

    async def stream(self, manager, run_id, run_meta, runtime, agent_url, request_payload) -> str:
        await self._emit(manager, run_id, run_meta, runtime, self._interrupts(self.pending))
        return "completed"

    async def resume(self, manager, run_id, run_meta, runtime, resume_url, base_config, payloads) -> str:
        ids = [p["interrupt_id"] for p in payloads]
        stale = [i for i in ids if i not in self.pending]
        if stale:
            # The agents service's 409: nothing applied, stale and pending listed.
            self.refused.append(ids)
            raise StaleDecisions(stale, list(self.pending))
        self.legs.append(ids)
        self.pending = [i for i in self.pending if i not in ids]
        self.leg_running.set()
        await asyncio.sleep(self.leg_seconds)
        self.leg_running.clear()
        await self._emit(manager, run_id, run_meta, runtime, self._interrupts(self.pending))
        return "completed"


@pytest_asyncio.fixture
async def seeded_run(session_factory, seeded_user, seeded_agent, monkeypatch):
    """A queued run (user message + AI placeholder) the manager can launch."""
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id, agent_id=seeded_agent.id, agent_name=seeded_agent.name,
            title="Parallel approvals", is_private=False,
        )
        session.add(conversation)
        await session.flush()
        question = MessageTable(conversation_id=conversation.id, sender="user", content="Edit three files in parallel")
        session.add(question)
        await session.flush()
        run = MessageTable(
            conversation_id=conversation.id, parent_message_id=question.id, sender="ai", content="",
            raw_events=[], agent_id=seeded_agent.id, agent_name=seeded_agent.name,
            streaming_status="queued", streaming_started_at=ir._now(),
        )
        session.add(run)
        await session.flush()
        run.streaming_message_path = [question.id, run.id]
        conversation.active_assistant_message_id = run.id
        await session.commit()
        run_id = run.id

    monkeypatch.setattr(ir, "SessionLocal", session_factory)

    async def _agent(agent_id):
        return seeded_agent

    monkeypatch.setattr(ir, "get_agent_by_id", _agent)
    monkeypatch.setattr(ir, "build_agent_stream_url", lambda agent: "http://agents.test/stream")
    monkeypatch.setattr(ir, "build_agent_resume_url", lambda agent: "http://agents.test/resume")
    return run_id


@pytest.fixture
def fake_agents(monkeypatch):
    fake = FakeAgents()

    async def _do_stream(self, *args):
        return await fake.stream(self, *args)

    async def _do_resume(self, *args):
        return await fake.resume(self, *args)

    monkeypatch.setattr(ir.InferenceRunManager, "_do_stream", _do_stream)
    monkeypatch.setattr(ir.InferenceRunManager, "_do_resume", _do_resume)
    return fake


async def _until(predicate, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.005)


def _paused_on_three(run_id: str) -> bool:
    runtime = inference_run_manager._runtimes.get(run_id)
    return runtime is not None and runtime.pending_interrupts == 3


async def _finished(run_id: str, session_factory) -> MessageTable:
    task = inference_run_manager._tasks.get(run_id)
    if task is not None:
        await asyncio.wait_for(task, timeout=5)
    async with session_factory() as session:
        return await session.get(MessageTable, run_id)


def _resolved_ids(run: MessageTable) -> list[str]:
    return [
        e["value"]["interrupt_id"] for e in run.raw_events or []
        if e.get("type") == "CUSTOM" and e.get("name") == "BRIDGE_HITL_RESOLVED"
    ]


@pytest.mark.parametrize("batch, legs", [(True, [list(IDS)]), (False, [[i] for i in IDS])])
async def test_three_near_simultaneous_decisions_all_apply_in_the_order_the_run_surfaced_them(
    seeded_run, fake_agents, session_factory, monkeypatch, batch, legs,
):
    monkeypatch.setattr(settings.inference, "batch_hitl_resume", batch)
    inference_run_manager.launch(seeded_run)
    await _until(lambda: _paused_on_three(seeded_run))

    # Clicked out of order, all before the run wakes up.
    for interrupt_id in ("int-helper-3", "int-helper-1", "int-helper-2"):
        assert inference_run_manager.request_resume(seeded_run, _decision(interrupt_id)) is ResumeOutcome.ACCEPTED

    run = await _finished(seeded_run, session_factory)
    assert fake_agents.legs == legs
    assert run.streaming_status == "completed"
    assert _resolved_ids(run) == list(IDS)


@pytest.mark.parametrize("batch, legs", [
    (True, [["int-helper-1"], ["int-helper-2", "int-helper-3"]]),
    (False, [["int-helper-1"], ["int-helper-2"], ["int-helper-3"]]),
])
async def test_decisions_arriving_while_a_resume_leg_streams_are_queued_not_overwritten(
    seeded_run, fake_agents, session_factory, monkeypatch, batch, legs,
):
    # The incident exactly: the first approval's leg is still streaming when
    # the other two arrive. The third used to overwrite the second.
    monkeypatch.setattr(settings.inference, "batch_hitl_resume", batch)
    inference_run_manager.launch(seeded_run)
    await _until(lambda: _paused_on_three(seeded_run))

    assert inference_run_manager.request_resume(seeded_run, _decision("int-helper-1")) is ResumeOutcome.ACCEPTED
    await asyncio.wait_for(fake_agents.leg_running.wait(), timeout=5)
    assert inference_run_manager.request_resume(seeded_run, _decision("int-helper-2")) is ResumeOutcome.ACCEPTED
    assert inference_run_manager.request_resume(seeded_run, _decision("int-helper-3", "reject", reason="no")) is ResumeOutcome.ACCEPTED

    run = await _finished(seeded_run, session_factory)
    assert fake_agents.legs == legs
    assert run.streaming_status == "completed"
    assert _resolved_ids(run) == list(IDS)
    marker = next(e for e in run.raw_events if e.get("name") == "BRIDGE_HITL_RESOLVED" and e["value"]["interrupt_id"] == "int-helper-3")
    assert marker["value"]["decision"] == "reject" and marker["value"]["reason"] == "no"


async def test_unknown_and_conflicting_decisions_are_refused_and_duplicates_apply_once(
    seeded_run, fake_agents, session_factory,
):
    inference_run_manager.launch(seeded_run)
    await _until(lambda: _paused_on_three(seeded_run))

    assert inference_run_manager.request_resume(seeded_run, _decision("int-made-up")) is ResumeOutcome.UNKNOWN_INTERRUPT
    assert inference_run_manager.request_resume(seeded_run, _decision("int-helper-1")) is ResumeOutcome.ACCEPTED
    assert inference_run_manager.request_resume(seeded_run, _decision("int-helper-1")) is ResumeOutcome.ALREADY_RECEIVED
    assert inference_run_manager.request_resume(seeded_run, _decision("int-helper-1", "reject")) is ResumeOutcome.CONFLICTING_DECISION
    await _until(lambda: fake_agents.legs)
    for interrupt_id in IDS[1:]:
        inference_run_manager.request_resume(seeded_run, _decision(interrupt_id))

    run = await _finished(seeded_run, session_factory)
    assert [i for leg in fake_agents.legs for i in leg] == list(IDS)
    assert _resolved_ids(run) == list(IDS)
    # The run is gone with its queue: nothing is accepted any more.
    assert inference_run_manager.request_resume(seeded_run, _decision("int-helper-1")) is ResumeOutcome.NOT_PAUSED


async def test_the_route_answers_409_with_the_reason_for_a_decision_it_cannot_apply(
    client, seeded_user, seeded_run, fake_agents, session_factory,
):
    inference_run_manager.launch(seeded_run)
    await _until(lambda: _paused_on_three(seeded_run))
    url = f"/v1/inference/runs/{seeded_user.id}/{seeded_run}/resume"

    unknown = await client.post(url, json={"interruptId": "int-made-up", "decision": "approve"})
    assert unknown.status_code == 409
    assert "not pending" in unknown.json()["detail"]

    first = await client.post(url, json={"interruptId": "int-helper-1", "decision": "approve"})
    assert first.status_code == 200
    again = await client.post(url, json={"interruptId": "int-helper-1", "decision": "approve"})
    assert again.status_code == 200
    changed = await client.post(url, json={"interruptId": "int-helper-1", "decision": "reject"})
    assert changed.status_code == 409
    assert "already received" in changed.json()["detail"]

    inference_run_manager.request_cancel(seeded_run)
    run = await _finished(seeded_run, session_factory)
    assert run.streaming_status == "cancelled"


async def test_cancel_while_decisions_are_queued_ends_the_run_and_drops_its_queue(
    seeded_run, fake_agents, session_factory,
):
    fake_agents.leg_seconds = 0.3
    inference_run_manager.launch(seeded_run)
    await _until(lambda: _paused_on_three(seeded_run))
    inference_run_manager.request_resume(seeded_run, _decision("int-helper-1"))
    await asyncio.wait_for(fake_agents.leg_running.wait(), timeout=5)
    inference_run_manager.request_resume(seeded_run, _decision("int-helper-2"))
    assert len(inference_run_manager._resume_queues[seeded_run]) == 1

    inference_run_manager.request_cancel(seeded_run)
    run = await _finished(seeded_run, session_factory)
    assert run.streaming_status == "cancelled"
    assert fake_agents.legs == [["int-helper-1"]]
    for registry in (
        inference_run_manager._resume_queues, inference_run_manager._resume_events,
        inference_run_manager._runtimes, inference_run_manager._tasks,
    ):
        assert seeded_run not in registry


# ---------------------------------------------------------------------------
# What _do_resume sends to the agents service
# ---------------------------------------------------------------------------
@pytest.fixture
def captured_resume_body(monkeypatch):
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, text="", headers={"content-type": "text/event-stream"})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        ir.httpx, "AsyncClient",
        lambda *args, **kwargs: real(transport=httpx.MockTransport(handler), timeout=kwargs.get("timeout")),
    )
    return bodies


async def _resume_once(payloads) -> None:
    runtime = ir.InferenceRunRuntime()
    config = {"run_config": {"configurable": {"thread_id": "thread-1"}}, "context": {"run_id": "r"}}
    result = await inference_run_manager._do_resume("r", {}, runtime, "http://agents.test/resume", config, payloads)
    assert result == "completed"


async def test_a_batch_goes_out_as_one_resume_keyed_by_interrupt(captured_resume_body):
    await _resume_once([_decision("int-helper-1"), _decision("int-helper-2", "reject", reason="no")])
    body = captured_resume_body[0]
    # The first decision also fills the one-at-a-time fields.
    assert (body["interrupt_id"], body["decision"], body["thread_id"]) == ("int-helper-1", "approve", "thread-1")
    assert body["resumes"] == [
        {"interrupt_id": "int-helper-1", "decision": "approve", "reason": None, "value": None, "decisions": None},
        {"interrupt_id": "int-helper-2", "decision": "reject", "reason": "no", "value": None, "decisions": None},
    ]


async def test_a_single_decision_keeps_the_one_at_a_time_shape(captured_resume_body):
    await _resume_once([_decision("int-helper-1")])
    assert "resumes" not in captured_resume_body[0]
    assert captured_resume_body[0]["interrupt_id"] == "int-helper-1"


# ---------------------------------------------------------------------------
# Redis: the blocking stream read outlasts its block time
# ---------------------------------------------------------------------------
def test_the_stream_reader_socket_outlasts_the_xread_block():
    timeout = cache_client.stream_read_socket_timeout()
    assert timeout == settings.redis.read_block_ms / 1000 + cache_client.STREAM_READ_TIMEOUT_MARGIN_SECONDS
    assert timeout > settings.redis.read_block_ms / 1000
    reader = cache_client.create_redis_client(socket_timeout=timeout)
    assert reader.connection_pool.connection_kwargs["socket_timeout"] == timeout


def test_ordinary_clients_keep_the_short_default_timeout():
    client = cache_client.create_redis_client()
    assert "socket_timeout" not in client.connection_pool.connection_kwargs


async def test_the_event_log_reads_on_its_own_long_timeout_client(monkeypatch):
    made: list[dict[str, Any]] = []

    def factory(**kwargs):
        made.append(kwargs)
        return object()

    monkeypatch.setattr(event_log_module, "create_redis_client", factory)
    log = event_log_module.RedisEventLog()
    await log._get_client()
    await log._get_reader()
    assert made == [{}, {"socket_timeout": cache_client.stream_read_socket_timeout()}]


# ---------------------------------------------------------------------------
# A stale id in a batch: void it, send the rest again, stay paused
# ---------------------------------------------------------------------------
def _markers(run: MessageTable) -> dict[str, dict[str, Any]]:
    """The last resolved marker per interrupt (a re-sent decision has two)."""
    return {
        e["value"]["interrupt_id"]: e["value"] for e in run.raw_events or []
        if e.get("type") == "CUSTOM" and e.get("name") == "BRIDGE_HITL_RESOLVED"
    }


async def test_a_stale_id_in_a_batch_is_voided_and_the_rest_is_sent_again(
    seeded_run, fake_agents, session_factory, monkeypatch,
):
    # The live failure: helper 1's approval vanished on the agent during helper
    # 3's leg; the batch [1, 2] then got a 409 and the whole run failed with
    # "no paused checkpoint" although helper 2 was still waiting.
    monkeypatch.setattr(settings.inference, "batch_hitl_resume", True)
    fake_agents.leg_seconds = 0.2
    inference_run_manager.launch(seeded_run)
    await _until(lambda: _paused_on_three(seeded_run))

    inference_run_manager.request_resume(seeded_run, _decision("int-helper-3"))
    await asyncio.wait_for(fake_agents.leg_running.wait(), timeout=5)
    fake_agents.pending.remove("int-helper-1")  # gone on the agent's side
    inference_run_manager.request_resume(seeded_run, _decision("int-helper-2"))
    inference_run_manager.request_resume(seeded_run, _decision("int-helper-1"))

    run = await _finished(seeded_run, session_factory)
    assert run.streaming_status == "completed"
    assert fake_agents.refused == [["int-helper-1", "int-helper-2"]]
    assert fake_agents.legs == [["int-helper-3"], ["int-helper-2"]]
    markers = _markers(run)
    # The stale one is cleared for the UI and marked as not applied.
    assert markers["int-helper-1"]["decision"] == EXPIRED_DECISION
    assert markers["int-helper-2"]["decision"] == "approve"


async def test_a_stale_decision_keeps_the_run_paused_on_what_is_still_pending(
    seeded_run, fake_agents, session_factory,
):
    inference_run_manager.launch(seeded_run)
    await _until(lambda: _paused_on_three(seeded_run))
    fake_agents.pending.remove("int-helper-1")

    inference_run_manager.request_resume(seeded_run, _decision("int-helper-1"))
    runtime = inference_run_manager._runtimes[seeded_run]
    await _until(lambda: runtime.pending_interrupt_ids == ["int-helper-2", "int-helper-3"])
    assert inference_run_manager.has_live_task(seeded_run), "the run failed instead of staying paused"
    assert fake_agents.legs == []

    for interrupt_id in ("int-helper-2", "int-helper-3"):
        inference_run_manager.request_resume(seeded_run, _decision(interrupt_id))
    run = await _finished(seeded_run, session_factory)
    assert run.streaming_status == "completed"


async def test_an_agent_paused_on_nothing_finishes_the_run_instead_of_failing_it(
    seeded_run, fake_agents, session_factory,
):
    inference_run_manager.launch(seeded_run)
    await _until(lambda: _paused_on_three(seeded_run))
    fake_agents.pending.clear()  # the agent finished: nothing left to resume

    inference_run_manager.request_resume(seeded_run, _decision("int-helper-2"))
    run = await _finished(seeded_run, session_factory)

    assert run.streaming_status == "completed"
    assert not run.error_message
    assert {i: m["decision"] for i, m in _markers(run).items()} == dict.fromkeys(IDS, EXPIRED_DECISION)


@pytest.fixture
def agents_conflict(monkeypatch):
    """The agents service answering every resume with a 409 of the given body."""
    reply: dict[str, Any] = {}
    real = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json=reply["body"])

    monkeypatch.setattr(
        ir.httpx, "AsyncClient",
        lambda *args, **kwargs: real(transport=httpx.MockTransport(handler), timeout=kwargs.get("timeout")),
    )
    return reply


async def test_a_stale_409_is_raised_for_recovery_not_turned_into_a_failure(agents_conflict):
    agents_conflict["body"] = {"detail": {
        "message": "The targeted interrupt is no longer pending.",
        "stale_interrupt_ids": ["int-helper-1"],
        "pending_interrupt_ids": ["int-helper-2"],
    }}
    with pytest.raises(StaleDecisions) as stale:
        await _resume_once([_decision("int-helper-1"), _decision("int-helper-2")])
    assert (stale.value.stale_ids, stale.value.pending_ids) == (["int-helper-1"], ["int-helper-2"])


async def test_any_other_409_still_fails_the_resume(agents_conflict, session_factory, monkeypatch):
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    agents_conflict["body"] = {"detail": "Something else."}
    runtime = ir.InferenceRunRuntime()
    config = {"run_config": {"configurable": {"thread_id": "thread-1"}}, "context": {"run_id": "r"}}
    result = await inference_run_manager._do_resume(
        "r", {}, runtime, "http://agents.test/resume", config, [_decision("int-helper-1")]
    )
    assert result == "failed"
