"""Workflow version history — the bridge's proxy routes.

Real schema on SQLite, the agents service as ``FakeAgentsService``. Pinned:

* list / one version / restore reach the agents service as the **session's**
  user, under ``/workflows/{owner}/{id}/versions…``, and come back camelCased
  and validated (a body that does not match is a 502, never passed through);
* paging is forwarded (``limit`` / ``before``) and ``nextBefore`` returned;
* restore is a save: the answer is the workflow (its new ``latestVersionNo``)
  and the schedule is re-synced from the restored spec;
* a 404 or a 422 (with its issues) from upstream is forwarded as is;
* restore needs a CSRF token; path ids and version numbers are restricted.
"""
from __future__ import annotations

from typing import Any

import httpx
import pytest

import utils.workflow_schedules as workflow_schedules
from core.auth.session import require_csrf_protection
from core.database import WorkflowScheduleTable

WF_ID = "wf-hist-1"


def _summary(number: int, **over: Any) -> dict[str, Any]:
    row = {
        "version_no": number, "created_at": "2026-11-01T10:00:00", "created_by": "u",
        "restored_from": None, "name": f"Flow v{number}", "description": "",
        "node_count": 2, "edge_count": 1,
    }
    row.update(over)
    return row


def _spec(trigger_kind: str = "trigger.manual") -> dict[str, Any]:
    config: dict[str, Any] = {}
    if trigger_kind == "trigger.schedule":
        config = {"schedule_kind": "interval", "schedule_spec": {"interval_seconds": 3600}}
    return {
        "version": 1, "name": "Flow", "inputs": [], "state": [],
        "nodes": [{"id": "start", "kind": trigger_kind, "config": config}, {"id": "done", "kind": "end", "config": {}}],
        "edges": [{"id": "e1", "source": "start", "target": "done"}],
    }


@pytest.fixture(autouse=True)
def _env(monkeypatch, session_factory):
    monkeypatch.setattr(workflow_schedules, "SessionLocal", session_factory)


async def test_list_is_proxied_paged_and_camelcased(client, agents_service, seeded_user):
    path = f"/workflows/{seeded_user.id}/{WF_ID}/versions"
    agents_service.on("GET", path, httpx.Response(200, json={
        "items": [_summary(5, restored_from=2), _summary(4)], "next_before": 4,
    }))
    resp = await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions?limit=2&before=6")
    assert resp.status_code == 200
    body = resp.json()
    assert body["nextBefore"] == 4
    first = body["items"][0]
    assert first == {
        "versionNo": 5, "createdAt": "2026-11-01T10:00:00Z", "createdBy": "u", "restoredFrom": 2,
        "name": "Flow v5", "description": "", "nodeCount": 2, "edgeCount": 1,
    }
    sent = agents_service.called("GET", path)[0]
    assert sent.url.params["limit"] == "2" and sent.url.params["before"] == "6"


async def test_one_version_is_proxied_with_its_spec(client, agents_service, seeded_user):
    path = f"/workflows/{seeded_user.id}/{WF_ID}/versions/3"
    agents_service.on("GET", path, httpx.Response(200, json={
        "version_no": 3, "created_at": "2026-11-01T10:00:00", "created_by": "u", "restored_from": None,
        "spec": _spec(),
    }))
    resp = await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions/3")
    assert resp.status_code == 200
    assert resp.json()["versionNo"] == 3 and resp.json()["spec"] == _spec()


async def test_an_unexpected_upstream_body_is_a_502(client, agents_service, seeded_user):
    agents_service.on("GET", f"/workflows/{seeded_user.id}/{WF_ID}/versions/3", httpx.Response(200, json={"nope": 1}))
    resp = await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions/3")
    assert resp.status_code == 502


async def test_restore_returns_the_workflow_and_resyncs_its_schedule(
    client, agents_service, seeded_user, session_factory
):
    path = f"/workflows/{seeded_user.id}/{WF_ID}/versions/2/restore"
    agents_service.on("POST", path, httpx.Response(200, json={
        "id": WF_ID, "name": "Flow", "description": "", "spec": _spec("trigger.schedule"),
        "latest_version_no": 6, "created_at": "2026-11-01T10:00:00", "updated_at": "2026-11-02T10:00:00",
    }))
    resp = await client.post(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions/2/restore")
    assert resp.status_code == 200
    body = resp.json()
    assert body["latestVersionNo"] == 6
    assert body["schedule"] is not None and body["schedule"]["kind"] == "interval"
    async with session_factory() as db:
        assert await db.get(WorkflowScheduleTable, WF_ID) is not None
    assert len(agents_service.called("POST", path)) == 1


async def test_upstream_404_and_422_are_forwarded(client, agents_service, seeded_user):
    base = f"/workflows/{seeded_user.id}/{WF_ID}/versions"
    agents_service.on("GET", f"{base}/9", httpx.Response(404, json={"detail": "Unknown workflow."}))
    resp = await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions/9")
    assert resp.status_code == 404

    issues = [{"nodeId": "poll", "path": "nodes[1].config.url", "message": "Unknown input nope."}]
    agents_service.on("POST", f"{base}/1/restore", httpx.Response(422, json={
        "detail": {"message": "This version no longer passes today's checks, so it can't be restored.", "errors": issues},
    }))
    resp = await client.post(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions/1/restore")
    assert resp.status_code == 422
    assert resp.json()["detail"]["errors"] == issues


async def test_restore_needs_csrf(client, app, agents_service, seeded_user):
    app.dependency_overrides.pop(require_csrf_protection)
    resp = await client.post(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions/1/restore")
    assert resp.status_code == 403
    assert not agents_service.calls


async def test_path_ids_and_version_numbers_are_restricted(client, agents_service, seeded_user):
    assert (await client.get(f"/v1/workflows/{seeded_user.id}/bad%20id/versions")).status_code == 422
    assert (await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions/0")).status_code == 422
    assert (await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions/abc")).status_code == 422
    assert (await client.get(f"/v1/workflows/{seeded_user.id}/{WF_ID}/versions?limit=500")).status_code == 422
    assert not agents_service.calls
