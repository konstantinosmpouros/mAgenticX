"""Workflow runs (plan 38, step 1) — the bridge side.

Run against the real schema on SQLite, the agents service played by an
``httpx.MockTransport`` that answers the run stream with canned AG-UI SSE, and
Redis by the suite's fakeredis. What is pinned:

* a run persists every event in order with increasing ``seq`` (across a
  resume too), lifts the ``workflow`` block into columns, and moves
  running → waiting (approval) → succeeded on resume; RUN_ERROR and a stream
  that just stops end it ``failed``;
* the agents service gets the contract body (owner, thread, pinned version,
  inputs, resume) — and a resume reuses the run's thread;
* one live run per workflow (409), someone else's run is a 404 everywhere;
* the run list is keyset-paged newest first; the event stream replays from
  ``after_seq`` / ``Last-Event-ID`` and tails live frames until the run ends;
* caps: events past the per-run cap and oversized events are marked, not kept;
* the watchdog fails stalled legs and expired approvals; deleting a workflow
  deletes its runs; old runs are pruned; account purge and export include runs.
"""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select

import utils.account_deletion as account_deletion
import utils.data_export as data_export
import utils.workflow_runs as workflow_runs
from core.auth.session import require_current_user
from core.database import UserTable, WorkflowRunEventTable, WorkflowRunTable
from core.settings import settings
from utils.workflow_runs import workflow_event_log, workflow_run_manager

WF_ID = "wf-1"
STREAM_PATH = "/workflows/runs/stream"


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _sse(*events: dict[str, Any]) -> bytes:
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode("utf-8")


def _wf(run_id: str, node: str | None = None, execution: str | None = None,
        parent: str | None = None) -> dict[str, Any]:
    return {"runId": run_id, "nodeId": node, "executionId": execution,
            "parentExecutionId": parent, "iteration": None}


def _first_leg(run_id: str) -> list[dict[str, Any]]:
    """A node that runs, then an approval node that pauses the run."""
    return [
        {"type": "RUN_STARTED", "threadId": "t", "runId": run_id, "workflow": _wf(run_id)},
        {"type": "STEP_STARTED", "stepName": "summarise", "workflow": _wf(run_id, "n1", "e1")},
        {"type": "CUSTOM", "name": "workflow.node_input", "value": {"text": "hi"}, "workflow": _wf(run_id, "n1", "e1")},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": "hello", "workflow": _wf(run_id, "n1", "e1")},
        {"type": "CUSTOM", "name": "workflow.node_output",
         "value": {"output": "hello", "branch": None, "durationMs": 5, "error": None},
         "workflow": _wf(run_id, "n1", "e1")},
        {"type": "STATE_DELTA", "delta": [], "workflow": _wf(run_id, "n1", "e1")},
        {"type": "STEP_FINISHED", "stepName": "summarise", "workflow": _wf(run_id, "n1", "e1")},
        {"type": "STEP_STARTED", "stepName": "approve", "workflow": _wf(run_id, "n2", "e2", "e1")},
        {"type": "CUSTOM", "name": "HITL_INTERRUPT", "value": {"interrupt": {"id": "i1"}},
         "workflow": _wf(run_id, "n2", "e2", "e1")},
        {"type": "RUN_FINISHED", "threadId": "t", "runId": run_id, "workflow": _wf(run_id)},
    ]


def _resume_leg(run_id: str) -> list[dict[str, Any]]:
    return [
        {"type": "RUN_STARTED", "threadId": "t", "runId": run_id, "workflow": _wf(run_id)},
        {"type": "STEP_FINISHED", "stepName": "approve", "workflow": _wf(run_id, "n2", "e2", "e1")},
        {"type": "RUN_FINISHED", "threadId": "t", "runId": run_id, "workflow": _wf(run_id)},
    ]


def _workflow_body(**over: Any) -> dict[str, Any]:
    body = {
        "id": WF_ID, "name": "My flow", "description": "d", "spec": {"nodes": []},
        "latest_version_no": 3, "created_at": "2026-11-01T10:00:00", "updated_at": "2026-11-02T10:00:00",
    }
    body.update(over)
    return body


@pytest.fixture(autouse=True)
def _wf_env(monkeypatch, session_factory):
    """The module's own sessions on the test DB; small, fast batches."""
    monkeypatch.setattr(workflow_runs, "SessionLocal", session_factory)
    cfg = settings.workflows
    monkeypatch.setattr(cfg, "persist_batch_size", 3)
    monkeypatch.setattr(cfg, "persist_interval_ms", 10)
    monkeypatch.setattr(cfg, "stream_heartbeat_seconds", 1)
    # A short XREAD block so the live tail's idle check runs often.
    monkeypatch.setattr(settings.redis, "read_block_ms", 50)


@pytest.fixture
def upstream(agents_service, seeded_user):
    """The agents service: the workflow GET plus a scripted run stream.

    ``legs`` is consumed one per stream call; each is a callable taking the
    request body and returning the events (or an ``httpx.Response``).
    """
    agents_service.legs = []
    agents_service.bodies = []
    agents_service.on("GET", f"/workflows/{seeded_user.id}/{WF_ID}", httpx.Response(200, json=_workflow_body()))

    def stream(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        agents_service.bodies.append(body)
        leg = agents_service.legs.pop(0)
        result = leg(body)
        if isinstance(result, httpx.Response):
            return result
        return httpx.Response(200, content=_sse(*result), headers={"content-type": "text/event-stream"})

    agents_service.on("POST", STREAM_PATH, stream)
    return agents_service


async def _settle(run_id: str) -> None:
    task = workflow_run_manager._tasks.get(run_id)
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=10)


async def _start(client, user_id: str, inputs: dict[str, Any] | None = None) -> str:
    resp = await client.post(f"/v1/workflows/{user_id}/{WF_ID}/runs", json={"inputs": inputs or {}})
    assert resp.status_code == 202, resp.text
    run_id = resp.json()["runId"]
    await _settle(run_id)
    return run_id


async def _detail(client, user_id: str, run_id: str) -> dict[str, Any]:
    resp = await client.get(f"/v1/workflow-runs/{user_id}/{run_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _add_run(session_factory, user_id: str, *, workflow_id: str = WF_ID, status: str = "succeeded",
                   created_at: datetime | None = None, updated_at: datetime | None = None,
                   events: int = 0) -> str:
    created = created_at or _now()
    async with session_factory() as db:
        run = WorkflowRunTable(
            user_id=user_id, workflow_id=workflow_id, workflow_name="My flow", status=status,
            inputs={}, thread_id=f"thread-{created.timestamp()}", event_count=events,
            started_at=created, created_at=created, updated_at=updated_at or created,
        )
        db.add(run)
        await db.flush()
        for seq in range(1, events + 1):
            db.add(WorkflowRunEventTable(
                run_id=run.id, seq=seq, type="CUSTOM", node_id="n1", execution_id=f"e{seq}",
                payload={"type": "CUSTOM", "name": "x", "value": seq}, created_at=created,
            ))
        await db.commit()
        return run.id


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
async def test_run_waits_on_approval_then_succeeds_on_resume(client, upstream, seeded_user):
    uid = seeded_user.id
    upstream.legs = [lambda body: _first_leg(body["run_id"]), lambda body: _resume_leg(body["run_id"])]

    run_id = await _start(client, uid, {"topic": "x"})
    first = upstream.bodies[0]
    assert first["run_id"] == run_id
    assert first["owner_user_id"] == uid
    assert first["workflow_id"] == WF_ID
    assert first["version_no"] == 3
    assert first["inputs"] == {"topic": "x"}
    assert first["resume"] is None
    assert first["thread_id"]

    detail = await _detail(client, uid, run_id)
    assert detail["run"]["status"] == "waiting"
    assert detail["run"]["workflowName"] == "My flow"
    assert detail["run"]["versionNo"] == 3
    assert detail["inputs"] == {"topic": "x"}
    events = detail["events"]
    assert [e["seq"] for e in events] == list(range(1, 11))
    assert detail["run"]["eventCount"] == 10
    assert [e["type"] for e in events][:2] == ["RUN_STARTED", "STEP_STARTED"]
    interrupt = events[8]
    assert interrupt["payload"]["name"] == "HITL_INTERRUPT"
    assert (interrupt["nodeId"], interrupt["executionId"], interrupt["parentExecutionId"]) == ("n2", "e2", "e1")
    assert events[0]["nodeId"] is None

    resp = await client.post(f"/v1/workflow-runs/{uid}/{run_id}/resume", json={"decision": "approve", "comment": " ok "})
    assert resp.status_code == 202, resp.text
    assert resp.json()["status"] == "running"
    await _settle(run_id)

    second = upstream.bodies[1]
    assert second["thread_id"] == first["thread_id"]
    assert second["resume"] == {"decision": "approve", "comment": "ok"}

    detail = await _detail(client, uid, run_id)
    assert detail["run"]["status"] == "succeeded"
    assert detail["run"]["finishedAt"] is not None
    seqs = [e["seq"] for e in detail["events"]]
    assert seqs == list(range(1, len(seqs) + 1)) and len(seqs) == 14
    marker = detail["events"][10]
    assert marker["payload"]["name"] == workflow_runs.DECISION_MARKER
    assert marker["payload"]["value"] == {"decision": "approve", "comment": "ok"}
    assert marker["nodeId"] == "n2"  # lands on the approval node

    # A run no longer waiting cannot be resumed again.
    again = await client.post(f"/v1/workflow-runs/{uid}/{run_id}/resume", json={"decision": "reject"})
    assert again.status_code == 409


async def test_run_error_fails_the_run(client, upstream, seeded_user):
    upstream.legs = [lambda body: [
        {"type": "RUN_STARTED", "workflow": _wf(body["run_id"])},
        {"type": "RUN_ERROR", "message": "node n1 exploded", "workflow": _wf(body["run_id"])},
    ]]
    run_id = await _start(client, seeded_user.id)
    detail = await _detail(client, seeded_user.id, run_id)
    assert detail["run"]["status"] == "failed"
    assert detail["run"]["error"] == "node n1 exploded"
    assert [e["type"] for e in detail["events"]] == ["RUN_STARTED", "RUN_ERROR"]


async def test_stream_that_stops_without_finishing_fails(client, upstream, seeded_user):
    upstream.legs = [lambda body: [{"type": "RUN_STARTED", "workflow": _wf(body["run_id"])}]]
    run_id = await _start(client, seeded_user.id)
    run = (await _detail(client, seeded_user.id, run_id))["run"]
    assert run["status"] == "failed"
    assert run["error"] == "The workflow stream ended unexpectedly."


async def test_upstream_refusal_fails_the_run(client, upstream, seeded_user):
    upstream.legs = [lambda body: httpx.Response(404, json={"detail": "no such workflow"})]
    run_id = await _start(client, seeded_user.id)
    run = (await _detail(client, seeded_user.id, run_id))["run"]
    assert run["status"] == "failed"
    assert "HTTP 404" in run["error"]


async def test_second_live_run_is_a_conflict_until_cancelled(client, upstream, seeded_user):
    uid = seeded_user.id
    upstream.legs = [lambda body: _first_leg(body["run_id"]), lambda body: _resume_leg(body["run_id"])]
    run_id = await _start(client, uid)  # waiting — still holds the slot

    resp = await client.post(f"/v1/workflows/{uid}/{WF_ID}/runs", json={"inputs": {}})
    assert resp.status_code == 409

    cancel = await client.post(f"/v1/workflow-runs/{uid}/{run_id}/cancel")
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancelled"
    assert cancel.json()["finishedAt"] is not None

    await _start(client, uid)  # the slot is free again


async def test_unique_index_rejects_a_racing_second_live_run(session_factory, seeded_user):
    await _add_run(session_factory, seeded_user.id, status="running")
    with pytest.raises(Exception) as caught:
        await _add_run(session_factory, seeded_user.id, status="queued")
    assert "UNIQUE" in str(caught.value).upper()


async def test_cancel_reaches_a_streaming_leg(client, upstream, seeded_user, session_factory):
    """A cancel while the leg streams: the leg's next write finds the row
    cancelled and stops; nothing it buffered afterwards is kept."""
    uid = seeded_user.id
    gate = asyncio.Event()

    async def slow_stream():
        yield _sse({"type": "RUN_STARTED", "workflow": _wf("r")})
        await gate.wait()
        yield _sse({"type": "STEP_STARTED", "workflow": _wf("r", "n1", "e1")},
                   {"type": "RUN_FINISHED", "workflow": _wf("r")})

    upstream.legs = [lambda body: httpx.Response(200, content=slow_stream())]
    resp = await client.post(f"/v1/workflows/{uid}/{WF_ID}/runs", json={"inputs": {}})
    run_id = resp.json()["runId"]
    for _ in range(100):
        async with session_factory() as db:
            run = await db.get(WorkflowRunTable, run_id)
            if run.event_count == 1:
                break
        await asyncio.sleep(0.02)
    cancel = await client.post(f"/v1/workflow-runs/{uid}/{run_id}/cancel")
    assert cancel.json()["status"] == "cancelled"
    gate.set()
    await _settle(run_id)
    detail = await _detail(client, uid, run_id)
    assert detail["run"]["status"] == "cancelled"
    assert [e["type"] for e in detail["events"]] == ["RUN_STARTED"]


# ---------------------------------------------------------------------------
# Ownership
# ---------------------------------------------------------------------------
async def test_someone_elses_run_is_not_found(client, session_factory, seeded_user):
    async with session_factory() as db:
        other = UserTable(username="someone-else", oidc_subject="oid-someone-else", is_active=True)
        db.add(other)
        await db.commit()
        other_id = other.id
    run_id = await _add_run(session_factory, other_id, status="waiting", events=2)
    uid = seeded_user.id

    assert (await client.get(f"/v1/workflow-runs/{uid}/{run_id}")).status_code == 404
    assert (await client.get(f"/v1/workflow-runs/{uid}/{run_id}/events/stream")).status_code == 404
    assert (await client.post(f"/v1/workflow-runs/{uid}/{run_id}/resume", json={"decision": "approve"})).status_code == 404
    assert (await client.post(f"/v1/workflow-runs/{uid}/{run_id}/cancel")).status_code == 404
    listed = await client.get(f"/v1/workflows/{uid}/{WF_ID}/runs")
    assert listed.status_code == 200 and listed.json()["items"] == []
    async with session_factory() as db:
        assert (await db.get(WorkflowRunTable, run_id)).status == "waiting"


async def test_path_ids_are_restricted(client, seeded_user):
    resp = await client.get(f"/v1/workflow-runs/{seeded_user.id}/bad..id")
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Run list and event stream
# ---------------------------------------------------------------------------
async def test_run_list_is_cursor_paged_newest_first(client, session_factory, seeded_user, monkeypatch):
    monkeypatch.setattr(settings.workflows, "runs_page_size", 2)
    base = _now() - timedelta(hours=1)
    ids = [await _add_run(session_factory, seeded_user.id, created_at=base + timedelta(minutes=i)) for i in range(5)]
    await _add_run(session_factory, seeded_user.id, workflow_id="other-wf")

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        params = {"cursor": cursor} if cursor else {}
        resp = await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/runs", params=params)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        seen += [item["id"] for item in body["items"]]
        pages += 1
        cursor = body["nextCursor"]
        if cursor is None:
            break
    assert seen == list(reversed(ids))
    assert pages == 3

    bad = await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/runs", params={"cursor": "%%%"})
    assert bad.status_code == 400


def _frames(text: str) -> list[tuple[str | None, dict[str, Any]]]:
    out = []
    for block in text.split("\n\n"):
        event_id, data = None, None
        for line in block.splitlines():
            if line.startswith("id: "):
                event_id = line[4:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if data is not None:
            out.append((event_id, data))
    return out


async def test_event_stream_replays_after_seq(client, session_factory, seeded_user):
    run_id = await _add_run(session_factory, seeded_user.id, status="succeeded", events=5)
    resp = await client.get(f"/v1/workflow-runs/{seeded_user.id}/{run_id}/events/stream", params={"after_seq": 2})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    frames = _frames(resp.text)
    assert frames[0][1]["type"] == "status" and frames[0][1]["run"]["status"] == "succeeded"
    events = [(i, f["event"]["seq"]) for i, f in frames if f["type"] == "event"]
    assert events == [("3", 3), ("4", 4), ("5", 5)]

    # A reconnecting EventSource sends Last-Event-ID instead.
    resp = await client.get(f"/v1/workflow-runs/{seeded_user.id}/{run_id}/events/stream",
                            headers={"Last-Event-ID": "4"})
    assert [f["event"]["seq"] for _, f in _frames(resp.text) if f["type"] == "event"] == [5]


async def test_event_stream_tails_live_frames_until_the_run_ends(client, session_factory, seeded_user):
    uid = seeded_user.id
    run_id = await _add_run(session_factory, uid, status="running", events=2)

    async def live_leg():
        await asyncio.sleep(0.3)  # the viewer is tailing by now
        row3 = {"seq": 3, "type": "CUSTOM", "nodeId": "n1", "executionId": "e3", "parentExecutionId": None,
                "payload": {"type": "CUSTOM", "name": "x", "value": 3}, "createdAt": "2026-11-04T10:00:00Z"}
        async with session_factory() as db:
            db.add(WorkflowRunEventTable(run_id=run_id, seq=3, type="CUSTOM", node_id="n1", execution_id="e3",
                                         payload=row3["payload"], created_at=_now()))
            run = await db.get(WorkflowRunTable, run_id)
            run.event_count = 3
            await db.commit()
        # seq 2 again: a frame the replay already delivered is dropped by seq.
        await workflow_event_log.append(run_id, {"type": "events", "events": [{**row3, "seq": 2}, row3]})
        async with session_factory() as db:
            run = await db.get(WorkflowRunTable, run_id)
            run.status = "succeeded"
            run.finished_at = _now()
            await db.commit()
            await db.refresh(run)
            frame = workflow_runs._status_frame(run)
        await workflow_event_log.append(run_id, frame)

    producer = asyncio.create_task(live_leg())
    resp = await asyncio.wait_for(
        client.get(f"/v1/workflow-runs/{uid}/{run_id}/events/stream"), timeout=20
    )
    await producer
    frames = _frames(resp.text)
    assert [f["event"]["seq"] for _, f in frames if f["type"] == "event"] == [1, 2, 3]
    statuses = [f["run"]["status"] for _, f in frames if f["type"] == "status"]
    assert statuses[0] == "running" and statuses[-1] == "succeeded"


# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------
async def test_event_cap_and_oversized_events_are_marked(client, upstream, seeded_user, monkeypatch):
    monkeypatch.setattr(settings.workflows, "max_events_per_run", 4)
    monkeypatch.setattr(settings.workflows, "max_event_bytes", 1024)

    def leg(body):
        rid = body["run_id"]
        return [
            {"type": "RUN_STARTED", "workflow": _wf(rid)},
            {"type": "CUSTOM", "name": "big", "value": "x" * 5000, "workflow": _wf(rid, "n1", "e1")},
            *({"type": "TEXT_MESSAGE_CONTENT", "delta": str(i), "workflow": _wf(rid, "n1", "e1")} for i in range(10)),
            {"type": "RUN_FINISHED", "workflow": _wf(rid)},
        ]

    upstream.legs = [leg]
    run_id = await _start(client, seeded_user.id)
    detail = await _detail(client, seeded_user.id, run_id)
    assert detail["run"]["status"] == "succeeded"
    events = detail["events"]
    big = events[1]["payload"]
    assert big["truncated"] is True and big["name"] == "big" and big["originalBytes"] > 5000
    assert big["workflow"]["nodeId"] == "n1"
    assert len(json.dumps(big)) < 1024 + 200
    names = [e["payload"].get("name") for e in events]
    assert workflow_runs.TRUNCATION_MARKER in names
    assert events[-1]["type"] == "RUN_FINISHED"  # run-level events survive the cap
    assert len(events) == 6  # 4 kept + the marker + RUN_FINISHED


async def test_oversized_inputs_are_rejected(client, upstream, seeded_user, monkeypatch):
    monkeypatch.setattr(settings.workflows, "max_input_bytes", 300)
    resp = await client.post(f"/v1/workflows/{seeded_user.id}/{WF_ID}/runs", json={"inputs": {"x": "y" * 400}})
    assert resp.status_code == 422


async def test_active_run_cap_is_a_429(client, upstream, session_factory, seeded_user, monkeypatch):
    monkeypatch.setattr(settings.workflows, "max_active_runs_per_user", 1)
    await _add_run(session_factory, seeded_user.id, workflow_id="busy", status="running")
    resp = await client.post(f"/v1/workflows/{seeded_user.id}/{WF_ID}/runs", json={"inputs": {}})
    assert resp.status_code == 429


async def test_old_runs_are_pruned_on_start(client, upstream, session_factory, seeded_user, monkeypatch):
    monkeypatch.setattr(settings.workflows, "max_runs_per_workflow", 2)
    base = _now() - timedelta(hours=1)
    oldest = await _add_run(session_factory, seeded_user.id, created_at=base, events=3)
    await _add_run(session_factory, seeded_user.id, created_at=base + timedelta(minutes=1))
    await _add_run(session_factory, seeded_user.id, created_at=base + timedelta(minutes=2))
    upstream.legs = [lambda body: _first_leg(body["run_id"])]
    await _start(client, seeded_user.id)
    async with session_factory() as db:
        count = (await db.execute(select(func.count()).select_from(WorkflowRunTable))).scalar_one()
        assert count == 2
        assert await db.get(WorkflowRunTable, oldest) is None
        orphans = (await db.execute(
            select(func.count()).select_from(WorkflowRunEventTable).where(WorkflowRunEventTable.run_id == oldest)
        )).scalar_one()
        assert orphans == 0


# ---------------------------------------------------------------------------
# Watchdog, delete, purge, export
# ---------------------------------------------------------------------------
async def test_watchdog_fails_stalled_legs_and_expired_approvals(session_factory, seeded_user):
    long_ago = _now() - timedelta(days=3)
    stalled = await _add_run(session_factory, seeded_user.id, workflow_id="a", status="running", updated_at=long_ago)
    expired = await _add_run(session_factory, seeded_user.id, workflow_id="b", status="waiting", updated_at=long_ago)
    fresh = await _add_run(session_factory, seeded_user.id, workflow_id="c", status="waiting")

    assert await workflow_runs.reap_workflow_runs() == 2
    async with session_factory() as db:
        assert (await db.get(WorkflowRunTable, stalled)).status == "failed"
        expired_row = await db.get(WorkflowRunTable, expired)
        assert expired_row.status == "failed" and "expired" in expired_row.error
        assert (await db.get(WorkflowRunTable, fresh)).status == "waiting"


async def test_startup_cleanup_keeps_waiting_runs(session_factory, seeded_user):
    running = await _add_run(session_factory, seeded_user.id, workflow_id="a", status="running")
    waiting = await _add_run(session_factory, seeded_user.id, workflow_id="b", status="waiting")
    await workflow_runs.cleanup_orphaned_workflow_runs()
    async with session_factory() as db:
        assert (await db.get(WorkflowRunTable, running)).status == "failed"
        assert (await db.get(WorkflowRunTable, waiting)).status == "waiting"


async def test_deleting_a_workflow_deletes_its_runs(client, agents_service, session_factory, seeded_user):
    agents_service.on("DELETE", f"/workflows/{seeded_user.id}/{WF_ID}", httpx.Response(204))
    gone = await _add_run(session_factory, seeded_user.id, events=3)
    kept = await _add_run(session_factory, seeded_user.id, workflow_id="other")
    resp = await client.delete(f"/v1/workflows/{seeded_user.id}/{WF_ID}")
    assert resp.status_code == 204
    async with session_factory() as db:
        assert await db.get(WorkflowRunTable, gone) is None
        assert await db.get(WorkflowRunTable, kept) is not None
        assert (await db.execute(select(func.count()).select_from(WorkflowRunEventTable))).scalar_one() == 0


async def test_definition_proxy_validates_and_maps(client, app, agents_service, seeded_user):
    async def current_user():
        return seeded_user

    app.dependency_overrides[require_current_user] = current_user
    agents_service.on("POST", "/workflows/validate", httpx.Response(
        200, json={"ok": False, "errors": [{"nodeId": "n1", "path": "nodes[0].prompt", "message": "required"}]}
    ))
    agents_service.on("POST", f"/workflows/{seeded_user.id}", httpx.Response(201, json=_workflow_body()))
    agents_service.on("GET", "/workflows/catalog", httpx.Response(200, json={"nodes": [{"kind": "agent"}]}))

    resp = await client.post("/v1/workflows/validate", json={"spec": {"nodes": [{}]}})
    assert resp.json() == {"ok": False, "errors": [{"nodeId": "n1", "path": "nodes[0].prompt", "message": "required"}]}
    resp = await client.post(f"/v1/workflows/{seeded_user.id}", json={"spec": {"nodes": []}})
    assert resp.status_code == 201
    assert resp.json()["latestVersionNo"] == 3 and resp.json()["updatedAt"].endswith("Z")
    assert json.loads(agents_service.called("POST", f"/workflows/{seeded_user.id}")[0].content) == {"spec": {"nodes": []}}
    assert (await client.get("/v1/workflows/catalog")).json() == {"nodes": [{"kind": "agent"}]}


async def test_account_purge_deletes_runs_and_their_threads(session_factory, seeded_user, monkeypatch):
    monkeypatch.setattr(account_deletion, "SessionLocal", session_factory)
    monkeypatch.setattr(settings.account_deletion, "message_batch", 2)
    monkeypatch.setattr(settings.account_deletion, "thread_batch", 2)
    for wf in ("a", "b", "c"):
        await _add_run(session_factory, seeded_user.id, workflow_id=wf, events=5)

    pages = [page async for page in account_deletion._workflow_thread_id_pages(seeded_user.id)]
    assert sum(len(p) for p in pages) == 3

    counts: dict[str, Any] = {}
    await account_deletion._step_workflow_runs(seeded_user.id, "no-such-deletion", counts)
    assert counts["workflow_runs"] == 3 and counts["workflow_run_events"] == 15
    async with session_factory() as db:
        assert (await db.execute(select(func.count()).select_from(WorkflowRunTable))).scalar_one() == 0
        assert (await db.execute(select(func.count()).select_from(WorkflowRunEventTable))).scalar_one() == 0
    assert account_deletion.STEPS.index(account_deletion.STEP_WORKFLOW_RUNS) < account_deletion.STEPS.index(
        account_deletion.STEP_USER
    )


async def test_export_includes_runs_and_events(session_factory, seeded_user, monkeypatch):
    monkeypatch.setattr(data_export, "SessionLocal", session_factory)
    monkeypatch.setattr(settings.export, "page_rows", 2)
    run_id = await _add_run(session_factory, seeded_user.id, events=3)
    runs = [r async for r in data_export._workflow_run_rows(seeded_user.id)]
    assert [r["id"] for r in runs] == [run_id]
    assert "thread_id" not in runs[0]
    events = [e async for e in data_export._all_workflow_run_events(seeded_user.id)]
    assert [(e["run_id"], e["seq"]) for e in events] == [(run_id, 1), (run_id, 2), (run_id, 3)]
