from __future__ import annotations

from datetime import datetime, timedelta

import pydantic
import pytest

import utils.scheduled_tasks as scheduled_tasks_util
from core.database import MessageTable, ScheduledTaskTable
from schemas import ScheduledTaskCreate
from utils.scheduled_tasks import claim_due_tasks, compute_next_run_at

try:
    import croniter as _croniter  # noqa: F401

    HAS_CRONITER = True
except ImportError:
    HAS_CRONITER = False


# ---------------------------------------------------------------------------
# Next-fire computation (pure)
# ---------------------------------------------------------------------------
def test_next_run_interval_advances_from_after():
    now = datetime(2026, 6, 27, 10, 0, 0)
    assert compute_next_run_at("interval", {"interval_seconds": 3600}, None, after=now) == now + timedelta(hours=1)


def test_next_run_one_off_future_then_spent():
    now = datetime(2026, 6, 27, 10, 0, 0)
    future = (now + timedelta(days=1)).isoformat()
    assert compute_next_run_at("one_off", {"run_at": future}, None, after=now) == now + timedelta(days=1)
    # A one-off whose moment has passed has no next fire.
    assert compute_next_run_at("one_off", {"run_at": now.isoformat()}, None, after=now) is None


def test_next_run_unknown_kind_is_none():
    assert compute_next_run_at("interval", {"interval_seconds": 0}, None, after=datetime(2026, 6, 27)) is None


@pytest.mark.skipif(not HAS_CRONITER, reason="croniter not installed on this host (runs in Docker)")
def test_next_run_cron_in_timezone():
    now = datetime(2026, 6, 27, 10, 0, 0)  # naive UTC
    nxt = compute_next_run_at("cron", {"cron_expr": "0 8 * * *"}, "UTC", after=now)
    assert nxt == datetime(2026, 6, 28, 8, 0, 0)


# ---------------------------------------------------------------------------
# Schema validation (boundary)
# ---------------------------------------------------------------------------
def test_create_schema_rejects_sub_minimum_interval():
    with pytest.raises(pydantic.ValidationError):
        ScheduledTaskCreate(agentId="a", prompt="x", scheduleKind="interval", intervalSeconds=5)


def test_create_schema_rejects_past_run_at():
    with pytest.raises(pydantic.ValidationError):
        ScheduledTaskCreate(agentId="a", prompt="x", scheduleKind="one_off", runAt=datetime(2000, 1, 1))


def test_create_schema_requires_cron_expr():
    with pytest.raises(pydantic.ValidationError):
        ScheduledTaskCreate(agentId="a", prompt="x", scheduleKind="cron")


def test_create_schema_defaults_target_mode_fresh():
    payload = ScheduledTaskCreate(agentId="a", prompt="  hi  ", scheduleKind="interval", intervalSeconds=3600)
    assert payload.targetMode == "fresh"
    assert payload.prompt == "hi"  # stripped


# ---------------------------------------------------------------------------
# Claim (selection + schedule advance). The FOR UPDATE SKIP LOCKED guarantee is
# Postgres-only; on the SQLite test DB it degrades to a plain SELECT, so this
# verifies the selection + advance logic, not the cross-process locking.
# ---------------------------------------------------------------------------
async def _insert_task(db_session_factory, seeded_user, seeded_agent, **overrides) -> str:
    async with db_session_factory() as session:
        task = ScheduledTaskTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            target_mode=overrides.get("target_mode", "fresh"),
            prompt=overrides.get("prompt", "do the thing"),
            schedule_kind=overrides["schedule_kind"],
            schedule_spec=overrides["schedule_spec"],
            status=overrides.get("status", "active"),
            next_run_at=overrides["next_run_at"],
        )
        session.add(task)
        await session.commit()
        return task.id


async def test_claim_due_interval_task_advances(db_session_factory, seeded_user, seeded_agent):
    tid = await _insert_task(
        db_session_factory, seeded_user, seeded_agent,
        schedule_kind="interval", schedule_spec={"interval_seconds": 3600},
        next_run_at=datetime(2020, 1, 1),
    )
    async with db_session_factory() as session:
        claimed = await claim_due_tasks(session, 10)
    assert tid in claimed
    async with db_session_factory() as session:
        reloaded = await session.get(ScheduledTaskTable, tid)
        assert reloaded.run_count == 1
        assert reloaded.last_run_at is not None
        assert reloaded.status == "active"
        assert reloaded.next_run_at is not None and reloaded.next_run_at > datetime(2025, 1, 1)


async def test_claim_skips_not_due_task(db_session_factory, seeded_user, seeded_agent):
    tid = await _insert_task(
        db_session_factory, seeded_user, seeded_agent,
        schedule_kind="interval", schedule_spec={"interval_seconds": 3600},
        next_run_at=datetime(2999, 1, 1),
    )
    async with db_session_factory() as session:
        claimed = await claim_due_tasks(session, 10)
    assert tid not in claimed


async def test_claim_one_off_completes(db_session_factory, seeded_user, seeded_agent):
    past = datetime(2020, 1, 1)
    tid = await _insert_task(
        db_session_factory, seeded_user, seeded_agent,
        schedule_kind="one_off", schedule_spec={"run_at": past.isoformat()},
        next_run_at=past,
    )
    async with db_session_factory() as session:
        claimed = await claim_due_tasks(session, 10)
    assert tid in claimed
    async with db_session_factory() as session:
        reloaded = await session.get(ScheduledTaskTable, tid)
        assert reloaded.status == "completed"
        assert reloaded.next_run_at is None


# ---------------------------------------------------------------------------
# CRUD API (create / list / pause / resume / delete) — agent resolution is
# monkeypatched (matches the conversation-router tests' pattern).
# ---------------------------------------------------------------------------
async def test_scheduled_task_crud_via_api(client, seeded_user, seeded_agent, monkeypatch):
    async def fake_get_agent_by_id(_agent_id):
        return seeded_agent

    monkeypatch.setattr(scheduled_tasks_util, "get_agent_by_id", fake_get_agent_by_id)

    create = await client.post(
        f"/v1/scheduled-tasks/{seeded_user.id}",
        json={
            "agentId": seeded_agent.id,
            "prompt": "Summarize what's new",
            "targetMode": "fresh",
            "scheduleKind": "interval",
            "intervalSeconds": 3600,
        },
    )
    assert create.status_code == 201
    task = create.json()
    task_id = task["id"]
    assert task["status"] == "active"
    assert task["scheduleKind"] == "interval"
    assert task["targetMode"] == "fresh"
    assert task["nextRunAt"] is not None

    listed = await client.get(f"/v1/scheduled-tasks/{seeded_user.id}")
    assert listed.status_code == 200
    assert any(item["id"] == task_id for item in listed.json())

    paused = await client.patch(
        f"/v1/scheduled-tasks/{seeded_user.id}/{task_id}", json={"status": "paused"}
    )
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"

    resumed = await client.patch(
        f"/v1/scheduled-tasks/{seeded_user.id}/{task_id}", json={"status": "active"}
    )
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "active"

    deleted = await client.delete(f"/v1/scheduled-tasks/{seeded_user.id}/{task_id}")
    assert deleted.status_code == 204

    after = await client.get(f"/v1/scheduled-tasks/{seeded_user.id}")
    assert all(item["id"] != task_id for item in after.json())


async def test_update_changes_schedule_and_recomputes_next_run(client, seeded_user, seeded_agent, monkeypatch):
    async def fake_get_agent_by_id(_agent_id):
        return seeded_agent

    monkeypatch.setattr(scheduled_tasks_util, "get_agent_by_id", fake_get_agent_by_id)

    create = await client.post(
        f"/v1/scheduled-tasks/{seeded_user.id}",
        json={"agentId": seeded_agent.id, "prompt": "x", "scheduleKind": "interval", "intervalSeconds": 3600},
    )
    task_id = create.json()["id"]

    upd = await client.patch(
        f"/v1/scheduled-tasks/{seeded_user.id}/{task_id}",
        json={
            "title": "Renamed",
            "prompt": "new prompt",
            "scheduleKind": "interval",
            "intervalSeconds": 7200,
        },
    )
    assert upd.status_code == 200
    body = upd.json()
    assert body["title"] == "Renamed"
    assert body["prompt"] == "new prompt"
    assert body["scheduleSpec"]["interval_seconds"] == 7200
    assert body["nextRunAt"] is not None


async def test_fire_creates_tagged_run(db_session_factory, seeded_user, seeded_agent, monkeypatch):
    """The fire path runs the real start_inference_flow (which calls db.expire_all());
    this regression-guards the reload-after-expire fix and the scheduled_task_id tag."""
    import utils.inference_start as inference_start_mod
    import utils.titles as titles_mod
    from utils.scheduled_tasks import fire_scheduled_task, inference_run_manager

    # Route the util's own SessionLocal to the test DB and stub the external bits.
    monkeypatch.setattr(scheduled_tasks_util, "SessionLocal", db_session_factory)

    async def fake_get_agent(_agent_id):
        return seeded_agent

    monkeypatch.setattr(scheduled_tasks_util, "get_agent_by_id", fake_get_agent)
    monkeypatch.setattr(inference_start_mod, "get_agent_by_id", fake_get_agent)

    async def fake_gen_title(*args, **kwargs):
        return None

    monkeypatch.setattr(titles_mod, "generate_conversation_title", fake_gen_title)

    captured: dict[str, str] = {}
    monkeypatch.setattr(inference_run_manager, "launch", lambda run_id: captured.__setitem__("run_id", run_id))

    tid = await _insert_task(
        db_session_factory, seeded_user, seeded_agent,
        schedule_kind="interval", schedule_spec={"interval_seconds": 3600},
        next_run_at=datetime(2020, 1, 1), prompt="Summarize the news",
    )
    async with db_session_factory() as session:
        task = await session.get(ScheduledTaskTable, tid)
        task.title = "Digest"
        await session.commit()

    # Must not raise (the reload-after-expire_all fix) and must persist + tag the run.
    await fire_scheduled_task(tid)

    async with db_session_factory() as session:
        task = await session.get(ScheduledTaskTable, tid)
        assert task.last_run_message_id is not None
        assert task.last_run_status == "running"
        run_message_id = task.last_run_message_id
        message = await session.get(MessageTable, run_message_id)
        assert message is not None
        assert message.scheduled_task_id == tid
        assert message.sender == "ai"
    assert captured.get("run_id") == run_message_id


async def test_create_rejects_unknown_agent(client, seeded_user, monkeypatch):
    async def fake_get_agent_by_id(_agent_id):
        return None

    monkeypatch.setattr(scheduled_tasks_util, "get_agent_by_id", fake_get_agent_by_id)

    resp = await client.post(
        f"/v1/scheduled-tasks/{seeded_user.id}",
        json={
            "agentId": "missing",
            "prompt": "x",
            "scheduleKind": "interval",
            "intervalSeconds": 3600,
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Unknown or inactive agent."
