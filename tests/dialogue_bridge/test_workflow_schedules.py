"""Workflow schedules (plan 38 §3.9) — a workflow scheduled by its start node.

Real schema on SQLite, the agents service as ``FakeAgentsService``, Redis by
the suite's fakeredis. What is pinned:

* sync: a create/update whose saved spec starts with an enabled
  ``trigger.schedule`` upserts the ``workflow_schedules`` row (same cadence →
  the clock is kept; a new cadence → re-armed; paused stays paused), a manual
  or disabled trigger deletes it, deleting the workflow deletes it;
* ``WorkflowOut.schedule`` on list/get/create/update (``null`` without one),
  with ``lastRunStatus`` read from the newest fire's run;
* pause / resume (404 without a schedule, ownership-scoped);
* the scheduler: a due row fires a run with ``trigger_kind = schedule`` and
  the static inputs, is advanced before firing, a one-off finishes, a live run
  makes the fire ``skipped``, a deleted workflow drops the row, a changed spec
  re-syncs instead of firing, a frozen account is skipped;
* account purge and export include the table.
"""
from __future__ import annotations

import asyncio
import copy
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import select

import utils.account_deletion as account_deletion
import utils.data_export as data_export
import utils.workflow_runs as workflow_runs
import utils.workflow_schedules as workflow_schedules
from core.database import (
    AccountDeletionTable,
    WorkflowRunTable,
    WorkflowScheduleTable,
)
from core.settings import settings
from utils.workflow_runs import workflow_run_manager

WF_ID = "wf-sched-1"
STREAM_PATH = "/workflows/runs/stream"


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _trigger(**config: Any) -> dict[str, Any]:
    base = {"schedule_kind": "interval", "schedule_spec": {"interval_seconds": 3600},
            "inputs": {"topic": "news"}}
    base.update(config)
    return {"id": "start", "kind": "trigger.schedule", "config": base}


def _spec(trigger: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "version": 1, "name": "Daily digest",
        "inputs": [{"name": "topic", "type": "string", "required": True}],
        "nodes": [trigger or _trigger(), {"id": "done", "kind": "end", "config": {}}],
        "edges": [{"id": "e1", "source": "start", "target": "done"}],
    }


def _manual_spec() -> dict[str, Any]:
    return _spec({"id": "start", "kind": "trigger.manual", "config": {}})


def _body(spec: dict[str, Any], workflow_id: str = WF_ID) -> dict[str, Any]:
    return {
        "id": workflow_id, "name": "Daily digest", "description": "", "spec": spec,
        "latest_version_no": 2, "created_at": "2026-11-01T10:00:00", "updated_at": "2026-11-02T10:00:00",
    }


def _sse(*events: dict[str, Any]) -> bytes:
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode("utf-8")


def _finishing_leg(run_id: str) -> list[dict[str, Any]]:
    wf = {"runId": run_id, "nodeId": None, "executionId": None, "parentExecutionId": None, "iteration": None}
    return [
        {"type": "RUN_STARTED", "threadId": "t", "runId": run_id, "workflow": wf},
        {"type": "RUN_FINISHED", "threadId": "t", "runId": run_id, "workflow": wf},
    ]


@pytest.fixture(autouse=True)
def _env(monkeypatch, session_factory):
    monkeypatch.setattr(workflow_runs, "SessionLocal", session_factory)
    monkeypatch.setattr(workflow_schedules, "SessionLocal", session_factory)
    monkeypatch.setattr(settings.workflows, "persist_batch_size", 3)
    monkeypatch.setattr(settings.workflows, "persist_interval_ms", 10)


@pytest.fixture
def upstream(agents_service, seeded_user):
    """Create/update/get/delete of one workflow, plus a run stream that finishes.

    ``upstream.spec`` is what the agents service "saved" — every answer
    carries it, as the real one returns the stored spec.
    """
    agents_service.spec = _spec()
    agents_service.bodies = []
    base = f"/workflows/{seeded_user.id}"

    def saved(status_code: int):
        def reply(request: httpx.Request) -> httpx.Response:
            return httpx.Response(status_code, json=_body(agents_service.spec))
        return reply

    def stream(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        agents_service.bodies.append(body)
        return httpx.Response(200, content=_sse(*_finishing_leg(body["run_id"])),
                              headers={"content-type": "text/event-stream"})

    agents_service.on("POST", base, saved(201))
    agents_service.on("PUT", f"{base}/{WF_ID}", saved(200))
    agents_service.on("GET", f"{base}/{WF_ID}", saved(200))
    agents_service.on("GET", base, lambda r: httpx.Response(200, json=[
        _body(agents_service.spec), _body(_manual_spec(), "wf-manual"),
    ]))
    agents_service.on("DELETE", f"{base}/{WF_ID}", httpx.Response(204))
    agents_service.on("POST", STREAM_PATH, stream)
    return agents_service


async def _row(session_factory, workflow_id: str = WF_ID) -> WorkflowScheduleTable | None:
    async with session_factory() as db:
        return await db.get(WorkflowScheduleTable, workflow_id)


async def _set_row(session_factory, **values: Any) -> None:
    async with session_factory() as db:
        row = await db.get(WorkflowScheduleTable, WF_ID)
        for key, value in values.items():
            setattr(row, key, value)
        await db.commit()


async def _settle(run_id: str) -> None:
    task = workflow_run_manager._tasks.get(run_id)
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=10)


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------
async def test_create_materialises_the_schedule(client, upstream, seeded_user, session_factory):
    before = _now()
    resp = await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": _spec()})
    assert resp.status_code == 201, resp.text
    schedule = resp.json()["schedule"]
    assert schedule["status"] == "active" and schedule["kind"] == "interval"
    assert schedule["spec"] == {"interval_seconds": 3600} and schedule["timezone"] is None
    assert schedule["nextRunAt"].endswith("Z") and schedule["lastRunAt"] is None
    assert schedule["lastRunStatus"] is None

    row = await _row(session_factory)
    assert row.user_id == seeded_user.id and row.node_id == "start" and row.inputs == {"topic": "news"}
    assert before + timedelta(seconds=3590) < row.next_run_at < _now() + timedelta(seconds=3610)


async def test_manual_start_node_has_no_schedule(client, upstream, seeded_user, session_factory):
    upstream.spec = _manual_spec()
    resp = await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    assert resp.status_code == 201 and resp.json()["schedule"] is None
    assert await _row(session_factory) is None


async def test_update_keeps_the_clock_unless_the_cadence_changes(client, upstream, seeded_user, session_factory):
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    pinned = _now() + timedelta(minutes=7)
    await _set_row(session_factory, next_run_at=pinned, status="paused")

    # Inputs change only: the clock and the paused state are kept.
    upstream.spec = _spec(_trigger(inputs={"topic": "sport"}))
    resp = await client.put(f"/v1/workflows/{seeded_user.id}/{WF_ID}", json={"spec": upstream.spec})
    assert resp.status_code == 200 and resp.json()["schedule"]["status"] == "paused"
    row = await _row(session_factory)
    assert row.next_run_at == pinned and row.inputs == {"topic": "sport"}

    # A new cadence re-arms the clock; paused still stays paused.
    upstream.spec = _spec(_trigger(schedule_kind="cron", schedule_spec={"cron_expr": "0 8 * * *"},
                                   timezone="Europe/Athens"))
    resp = await client.put(f"/v1/workflows/{seeded_user.id}/{WF_ID}", json={"spec": upstream.spec})
    schedule = resp.json()["schedule"]
    assert schedule["kind"] == "cron" and schedule["timezone"] == "Europe/Athens"
    assert schedule["status"] == "paused"
    row = await _row(session_factory)
    assert row.next_run_at != pinned and row.schedule_spec == {"cron_expr": "0 8 * * *"}


async def test_cron_without_a_zone_is_utc_and_the_interval_floor_holds(
    client, upstream, seeded_user, session_factory, monkeypatch
):
    upstream.spec = _spec(_trigger(schedule_kind="cron", schedule_spec={"cron_expr": "*/30 * * * *"}))
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    assert (await _row(session_factory)).timezone == "UTC"

    # A bridge floor stricter than the engine's clamps the interval.
    monkeypatch.setattr(settings.scheduler, "min_interval_seconds", 7200)
    upstream.spec = _spec()
    await client.put(f"/v1/workflows/{seeded_user.id}/{WF_ID}", json={"spec": upstream.spec})
    assert (await _row(session_factory)).schedule_spec == {"interval_seconds": 7200}


async def test_a_past_one_off_is_finished_not_armed(client, upstream, seeded_user, session_factory):
    upstream.spec = _spec(_trigger(schedule_kind="one_off", schedule_spec={"run_at": "2020-01-01T08:00:00Z"}))
    resp = await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    assert resp.json()["schedule"]["status"] == "finished"
    assert (await _row(session_factory)).next_run_at is None


@pytest.mark.parametrize("replacement", [_manual_spec(), _spec(_trigger(enabled=False))])
async def test_manual_or_disabled_trigger_deletes_the_row(
    client, upstream, seeded_user, session_factory, replacement
):
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    upstream.spec = copy.deepcopy(replacement)
    resp = await client.put(f"/v1/workflows/{seeded_user.id}/{WF_ID}", json={"spec": upstream.spec})
    assert resp.status_code == 200 and resp.json()["schedule"] is None
    assert await _row(session_factory) is None


async def test_an_unreadable_trigger_schedules_nothing(client, upstream, seeded_user, session_factory):
    upstream.spec = _spec(_trigger(schedule_kind="cron", schedule_spec={"cron_expr": "not a cron"}))
    resp = await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    assert resp.status_code == 201 and resp.json()["schedule"] is None
    upstream.spec = _spec(_trigger(schedule_kind="weekly"))
    resp = await client.put(f"/v1/workflows/{seeded_user.id}/{WF_ID}", json={"spec": upstream.spec})
    assert resp.status_code == 200 and resp.json()["schedule"] is None
    assert await _row(session_factory) is None


async def test_a_failed_sync_does_not_fail_the_save(client, upstream, seeded_user, session_factory, monkeypatch):
    async def broken(*args, **kwargs):
        raise workflow_schedules.SQLAlchemyError("db down")

    monkeypatch.setattr(workflow_schedules, "_apply", broken)
    resp = await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    assert resp.status_code == 201 and resp.json()["schedule"] is None


async def test_delete_workflow_deletes_the_schedule(client, upstream, seeded_user, session_factory):
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    resp = await client.delete(f"/v1/workflows/{seeded_user.id}/{WF_ID}")
    assert resp.status_code == 204
    assert await _row(session_factory) is None


async def test_list_and_get_carry_the_schedule(client, upstream, seeded_user, session_factory):
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    listed = {w["id"]: w for w in (await client.get(f"/v1/workflows/{seeded_user.id}")).json()}
    assert listed[WF_ID]["schedule"]["kind"] == "interval"
    assert listed["wf-manual"]["schedule"] is None
    got = (await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}")).json()
    assert got["schedule"]["status"] == "active"


# ---------------------------------------------------------------------------
# Pause / resume
# ---------------------------------------------------------------------------
async def test_pause_and_resume(client, upstream, seeded_user, session_factory):
    base = f"/v1/workflows/{seeded_user.id}/{WF_ID}/schedule"
    assert (await client.post(f"{base}/pause")).status_code == 404

    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    resp = await client.post(f"{base}/pause")
    assert resp.status_code == 200 and resp.json()["status"] == "paused"
    assert (await client.post(f"{base}/pause")).json()["status"] == "paused"

    # Missed while paused: resuming re-arms from now, never backfills.
    await _set_row(session_factory, next_run_at=_now() - timedelta(hours=5))
    resp = await client.post(f"{base}/resume")
    assert resp.json()["status"] == "active"
    assert (await _row(session_factory)).next_run_at > _now()


async def test_resuming_a_spent_one_off_finishes_it(client, upstream, seeded_user, session_factory):
    upstream.spec = _spec(_trigger(schedule_kind="one_off", schedule_spec={"run_at": "2099-01-01T08:00:00"}))
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    await _set_row(session_factory, status="paused", schedule_spec={"run_at": "2020-01-01T08:00:00"},
                   next_run_at=_now() - timedelta(days=1))
    resp = await client.post(f"/v1/workflows/{seeded_user.id}/{WF_ID}/schedule/resume")
    assert resp.json()["status"] == "finished"


async def test_someone_elses_schedule_is_not_found(session_factory, seeded_user):
    async with session_factory() as db:
        db.add(WorkflowScheduleTable(
            workflow_id=WF_ID, user_id=seeded_user.id, node_id="start", schedule_kind="interval",
            schedule_spec={"interval_seconds": 600}, inputs={}, status="active", next_run_at=_now(),
        ))
        await db.commit()
    async with session_factory() as db:
        with pytest.raises(workflow_schedules.HTTPException) as missing:
            await workflow_schedules.set_schedule_paused(db, "someone-else", WF_ID, paused=True)
    assert missing.value.status_code == 404
    assert (await _row(session_factory)).status == "active"


# ---------------------------------------------------------------------------
# The scheduler
# ---------------------------------------------------------------------------
async def _schedule_due(client, upstream, seeded_user, session_factory, **row: Any) -> None:
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    await _set_row(session_factory, next_run_at=_now() - timedelta(seconds=5), **row)


async def _tick() -> None:
    """One scheduler pass over workflow schedules, then let started legs finish."""
    await workflow_schedules.run_due_workflow_schedules()
    for run_id in list(workflow_run_manager._tasks):
        await _settle(run_id)


async def _runs(session_factory) -> list[WorkflowRunTable]:
    async with session_factory() as db:
        return list((await db.execute(select(WorkflowRunTable).order_by(WorkflowRunTable.created_at))).scalars())


async def test_a_due_schedule_fires_a_scheduled_run(client, upstream, seeded_user, session_factory):
    await _schedule_due(client, upstream, seeded_user, session_factory)
    await _tick()

    runs = await _runs(session_factory)
    assert len(runs) == 1
    run = runs[0]
    assert run.trigger_kind == "schedule" and run.inputs == {"topic": "news"} and run.status == "succeeded"
    sent = upstream.bodies[0]
    assert sent["trigger_kind"] == "schedule" and sent["inputs"] == {"topic": "news"} and sent["fired_at"]

    row = await _row(session_factory)
    assert row.run_count == 1 and row.last_run_id == run.id and row.last_run_status == "started"
    assert row.status == "active" and row.next_run_at > _now() + timedelta(minutes=50)
    got = (await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}")).json()["schedule"]
    assert got["lastRunStatus"] == "succeeded" and got["lastRunAt"].endswith("Z")

    # Not due any more: the next tick fires nothing.
    await _tick()
    assert len(await _runs(session_factory)) == 1


async def test_a_one_off_finishes_after_firing(client, upstream, seeded_user, session_factory):
    future = (_now() + timedelta(hours=1)).replace(microsecond=0).isoformat()
    upstream.spec = _spec(_trigger(schedule_kind="one_off", schedule_spec={"run_at": future}))
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})
    assert (await _row(session_factory)).status == "active"

    # Its moment arrives (spec and row agree on it, as after a normal save).
    moment = (_now() - timedelta(seconds=2)).replace(microsecond=0)
    upstream.spec = _spec(_trigger(schedule_kind="one_off", schedule_spec={"run_at": moment.isoformat()}))
    await _set_row(session_factory, schedule_spec={"run_at": moment.isoformat()}, next_run_at=moment)
    await _tick()

    row = await _row(session_factory)
    assert row.status == "finished" and row.next_run_at is None and row.run_count == 1
    assert [r.trigger_kind for r in await _runs(session_factory)] == ["schedule"]


async def test_a_live_run_makes_the_fire_skipped(client, upstream, seeded_user, session_factory):
    await _schedule_due(client, upstream, seeded_user, session_factory)
    async with session_factory() as db:
        db.add(WorkflowRunTable(
            user_id=seeded_user.id, workflow_id=WF_ID, workflow_name="Daily digest", status="waiting",
            inputs={}, thread_id="busy", event_count=0, trigger_kind="manual",
        ))
        await db.commit()
    await _tick()
    row = await _row(session_factory)
    assert row.last_run_status == "skipped" and row.last_run_id is None
    assert row.run_count == 1 and row.next_run_at > _now()  # advanced all the same
    assert len(await _runs(session_factory)) == 1
    got = (await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}")).json()["schedule"]
    assert got["lastRunStatus"] == "skipped"


async def test_a_deleted_workflow_drops_its_schedule_at_fire_time(client, upstream, seeded_user, session_factory):
    await _schedule_due(client, upstream, seeded_user, session_factory)
    upstream.on("GET", f"/workflows/{seeded_user.id}/{WF_ID}", httpx.Response(404, json={"detail": "nope"}))
    await _tick()
    assert await _row(session_factory) is None
    assert await _runs(session_factory) == []


async def test_a_changed_spec_resyncs_instead_of_firing(client, upstream, seeded_user, session_factory):
    await _schedule_due(client, upstream, seeded_user, session_factory)
    upstream.spec = _manual_spec()  # saved upstream, but the sync never ran
    await _tick()
    assert await _row(session_factory) is None
    assert await _runs(session_factory) == []


async def test_paused_and_frozen_schedules_do_not_fire(client, upstream, seeded_user, session_factory):
    await _schedule_due(client, upstream, seeded_user, session_factory, status="paused")
    await _tick()
    assert await _runs(session_factory) == []

    await _set_row(session_factory, status="active")
    async with session_factory() as db:
        db.add(AccountDeletionTable(user_id=seeded_user.id, user_ref="ref", requested_at=_now(),
                                    scheduled_for=_now() + timedelta(days=14)))
        await db.commit()
    await _tick()
    assert await _runs(session_factory) == []
    assert (await _row(session_factory)).run_count == 0


async def test_the_scheduler_tick_runs_workflow_schedules(client, upstream, seeded_user, session_factory, monkeypatch):
    calls = []

    async def fake_run_due():
        calls.append(True)
        return 0

    monkeypatch.setattr(workflow_schedules, "run_due_workflow_schedules", fake_run_due)
    scheduled_tasks = workflow_schedules.scheduled_tasks
    monkeypatch.setattr(scheduled_tasks, "SessionLocal", session_factory)
    await scheduled_tasks.Scheduler()._tick()
    assert calls == [True]


# ---------------------------------------------------------------------------
# Account purge and export
# ---------------------------------------------------------------------------
async def test_account_purge_and_export_include_schedules(client, upstream, seeded_user, session_factory, monkeypatch):
    await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": upstream.spec})

    monkeypatch.setattr(data_export, "SessionLocal", session_factory)
    rows = [r async for r in data_export._workflow_schedule_rows(seeded_user.id)]
    assert [r["workflow_id"] for r in rows] == [WF_ID]
    assert rows[0]["schedule_spec"] == {"interval_seconds": 3600} and "user_id" not in rows[0]

    monkeypatch.setattr(account_deletion, "SessionLocal", session_factory)
    await account_deletion._step_user(seeded_user.id, "no-such-deletion", {})
    assert await _row(session_factory) is None
