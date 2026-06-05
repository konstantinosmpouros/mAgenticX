"""Tests for the HITL resume plumbing on the dialogue_bridge side.

Three layers are exercised:

1. ``InferenceRunRuntime`` correctly counts pending HITL interrupts emitted at
   the orchestrator level *and* wrapped inside ``SUBAGENT_EVENT``. The pause
   logic on the manager depends on this counter being accurate.
2. ``InferenceRunManager.request_resume`` only accepts a payload when a live
   ``_run`` task is registered for the run, and exposes that state via the
   resume event + payload dicts so ``_do_resume`` can pick it up.
3. The ``POST /v1/inference/runs/{user}/{run}/resume`` route translates 404 /
   409 / 200 outcomes cleanly and forwards the request body verbatim to the
   manager.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest_asyncio

from core.database import MessageTable, UserTable
from router import inference as inference_router
from utils.inference_runs import (
    InferenceRunRuntime,
    inference_run_manager,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# InferenceRunRuntime — pending_interrupts accounting
# ---------------------------------------------------------------------------

def test_runtime_increments_pending_on_top_level_hitl():
    runtime = InferenceRunRuntime()
    runtime.apply_event({
        "type": "CUSTOM",
        "name": "HITL_INTERRUPT",
        "value": {"thread_id": "thread-1", "interrupt": {"question": "Continue?"}},
    })
    assert runtime.pending_interrupts == 1
    assert runtime.subagents is not None
    assert runtime.subagents.get("interrupts") == [
        {"thread_id": "thread-1", "interrupt": {"question": "Continue?"}}
    ]


def test_runtime_increments_pending_on_subagent_wrapped_hitl():
    runtime = InferenceRunRuntime()
    runtime.apply_event({
        "type": "CUSTOM",
        "name": "SUBAGENT_EVENT",
        "value": {
            "task_id": "task-A",
            "namespace": ["sub:task-A"],
            "event": {
                "type": "CUSTOM",
                "name": "HITL_INTERRUPT",
                "value": {"thread_id": "thread-2", "interrupt": {"q": "Send email?"}},
            },
        },
    })
    # Even though the HITL_INTERRUPT was wrapped, the runtime saw it and bumped
    # the counter so the manager will wait for /resume instead of finalising.
    assert runtime.pending_interrupts == 1


def test_runtime_does_not_increment_pending_on_unrelated_events():
    runtime = InferenceRunRuntime()
    runtime.apply_event({
        "type": "CUSTOM",
        "name": "PLAN_SNAPSHOT",
        "value": {"items": [{"content": "step-1", "status": "pending"}]},
    })
    runtime.apply_event({
        "type": "CUSTOM",
        "name": "TASK_SUBAGENT",
        "value": {"task_id": "t", "subagent_type": "writer"},
    })
    runtime.apply_event({
        "type": "CUSTOM",
        "name": "SUBAGENT_EVENT",
        "value": {
            "task_id": "t",
            "event": {"type": "TEXT_MESSAGE_CHUNK", "delta": "hello"},
        },
    })
    assert runtime.pending_interrupts == 0


def test_runtime_counts_multiple_hitl_interrupts():
    runtime = InferenceRunRuntime()
    for thread in ("a", "b", "c"):
        runtime.apply_event({
            "type": "CUSTOM",
            "name": "HITL_INTERRUPT",
            "value": {"thread_id": thread, "interrupt": {}},
        })
    assert runtime.pending_interrupts == 3


# ---------------------------------------------------------------------------
# InferenceRunManager.request_resume
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def parked_manager_run():
    """Register a long-lived task on the manager so request_resume sees a 'live' run."""
    run_id = f"resume-test-{id(object())}"
    event = asyncio.Event()

    async def _park() -> None:
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            return

    task = asyncio.create_task(_park())
    inference_run_manager._tasks[run_id] = task
    inference_run_manager._resume_events[run_id] = event
    try:
        yield run_id, event
    finally:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, BaseException):  # noqa: BLE001
            pass
        inference_run_manager._tasks.pop(run_id, None)
        inference_run_manager._resume_events.pop(run_id, None)
        inference_run_manager._resume_payloads.pop(run_id, None)


async def test_request_resume_returns_false_for_unknown_run():
    assert inference_run_manager.request_resume("does-not-exist", {"decision": "approve"}) is False


async def test_request_resume_stores_payload_and_flips_event(parked_manager_run):
    run_id, resume_event = parked_manager_run
    assert resume_event.is_set() is False

    accepted = inference_run_manager.request_resume(run_id, {
        "decision": "approve",
        "reason": "Looks good",
        "value": None,
    })

    assert accepted is True
    assert resume_event.is_set()
    assert inference_run_manager._resume_payloads[run_id] == {
        "decision": "approve",
        "reason": "Looks good",
        "value": None,
    }


# ---------------------------------------------------------------------------
# POST /v1/inference/runs/{user}/{run}/resume route
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def streaming_message(session_factory, seeded_user, seeded_agent):
    """Persist a conversation + AI placeholder in ``streaming_status='running'``."""
    from core.database import ConversationTable

    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="HITL test",
            is_private=False,
        )
        session.add(conversation)
        await session.flush()

        ai_message = MessageTable(
            conversation_id=conversation.id,
            sender="ai",
            type="text",
            content="",
            streaming_status="running",
            streaming_started_at=_utcnow(),
        )
        session.add(ai_message)
        await session.commit()
        await session.refresh(ai_message)
        await session.refresh(conversation)
        return {
            "conversation_id": conversation.id,
            "message_id": ai_message.id,
        }


async def test_resume_route_returns_404_for_unknown_run(client, seeded_user):
    response = await client.post(
        f"/v1/inference/runs/{seeded_user.id}/nonexistent-message-id/resume",
        json={"decision": "approve"},
    )
    assert response.status_code == 404


async def test_resume_route_returns_409_when_not_paused(client, seeded_user, streaming_message):
    # No task has been launched on the manager so request_resume() returns False.
    response = await client.post(
        f"/v1/inference/runs/{seeded_user.id}/{streaming_message['message_id']}/resume",
        json={"decision": "approve"},
    )
    assert response.status_code == 409
    assert "paused" in response.json()["detail"].lower()


async def test_resume_route_dispatches_to_manager_when_paused(
    client, seeded_user, streaming_message, monkeypatch,
):
    captured: dict[str, object] = {}

    def fake_request_resume(run_id: str, payload: dict) -> bool:
        captured["run_id"] = run_id
        captured["payload"] = payload
        return True

    monkeypatch.setattr(
        inference_router.inference_run_manager,
        "request_resume",
        fake_request_resume,
    )

    response = await client.post(
        f"/v1/inference/runs/{seeded_user.id}/{streaming_message['message_id']}/resume",
        json={
            "interruptId": "interrupt-abc-123",
            "decision": "reject",
            "reason": "Sensitive content",
            "value": {"source": "test"},
        },
    )

    assert response.status_code == 200
    assert captured["run_id"] == streaming_message["message_id"]
    assert captured["payload"] == {
        "decision": "reject",
        "reason": "Sensitive content",
        "value": {"source": "test"},
        "interrupt_id": "interrupt-abc-123",
    }


async def test_resume_route_rejects_invalid_decision(client, seeded_user, streaming_message):
    response = await client.post(
        f"/v1/inference/runs/{seeded_user.id}/{streaming_message['message_id']}/resume",
        json={"decision": "maybe"},
    )
    assert response.status_code == 422


async def test_resume_route_isolates_other_users(client, session_factory, seeded_user, streaming_message):
    """A different user must not be able to resume someone else's run."""
    # Seed a second user and route through them — overridden validate_userId
    # returns seeded_user, so we explicitly use a fake foreign user_id in the
    # URL and ensure the WHERE filter on conversation.user_id rejects it.
    foreign_user_id = "00000000-0000-0000-0000-000000000000"
    async with session_factory() as session:
        foreign_user = UserTable(
            id=foreign_user_id,
            username="other-user",
            vault_user_id="vault-other-user",
            is_active=True,
        )
        session.add(foreign_user)
        await session.commit()

    response = await client.post(
        f"/v1/inference/runs/{foreign_user_id}/{streaming_message['message_id']}/resume",
        json={"decision": "approve"},
    )
    # The conversation belongs to seeded_user, so the join filter on user_id
    # rejects the lookup and the route surfaces a clean 404 instead of leaking
    # the message to another tenant.
    assert response.status_code == 404
