"""Workflow version history — list, one version, restore (agents service).

Pinned here:

* the routes are internal-only and owner-scoped (another owner's workflow or
  version is a 404, like a missing one);
* the list is newest first, keyset-paged on ``version_no`` and carries a
  short summary (name, step and connection counts) instead of whole specs;
* restore **appends** a new version with the old spec and ``restored_from``
  set — history is never rewritten — and answers with the workflow as after
  a save; restoring a spec equal to the newest one adds nothing;
* an old spec that no longer validates is refused with every issue (422), and
  nothing is written;
* the store's SQL, against real Postgres when ``WORKFLOW_STORE_TEST_DSN`` (or
  ``CONVERSATION_FILES_TEST_DSN``) names a maintenance database; skipped
  otherwise.
"""
from __future__ import annotations

import asyncio
import copy
import importlib
import json
import os
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio

try:
    import psycopg
    from psycopg import conninfo, sql
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool
except ImportError:  # the routes half runs without a driver
    psycopg = None

EXAMPLE = Path(__file__).resolve().parent / "fixtures" / "workflows" / "fetch_loop_approval.json"
DSN = os.environ.get("WORKFLOW_STORE_TEST_DSN") or os.environ.get("CONVERSATION_FILES_TEST_DSN")
WORKFLOW_ID = "33333333-3333-3333-3333-333333333333"
NOW = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)


def _example() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


@pytest.fixture
def wf(agents_service):
    return SimpleNamespace(
        spec=importlib.import_module("harness.workflows.spec"),
        store=importlib.import_module("harness.workflows.store"),
        validator=importlib.import_module("harness.workflows.validator"),
        utils=importlib.import_module("utils.workflows"),
    )


class FakeVersionStore:
    """``WorkflowStore``'s definition + history half, in memory, same rules."""

    def __init__(self, canonical_json):
        self._canonical = canonical_json
        self.rows: dict[str, dict] = {}
        self.versions: dict[tuple[str, int], dict] = {}

    def seed(self, workflow_id: str, owner: str, specs: list[dict]) -> None:
        self.rows[workflow_id] = {
            "id": workflow_id, "owner_user_id": owner, "name": specs[-1]["name"],
            "description": specs[-1].get("description", ""), "latest_version_no": len(specs),
            "created_at": NOW, "updated_at": NOW, "draft": specs[-1],
        }
        for number, spec in enumerate(specs, start=1):
            self.versions[(workflow_id, number)] = {
                "version_no": number, "spec": spec, "created_by": owner, "created_at": NOW, "restored_from": None,
            }

    def _owned(self, owner, workflow_id):
        row = self.rows.get(workflow_id)
        return row if row is not None and row["owner_user_id"] == owner else None

    async def get(self, owner, workflow_id):
        row = self._owned(owner, workflow_id)
        if row is None:
            return None
        latest = self.versions[(workflow_id, row["latest_version_no"])]
        return {**row, "spec": latest["spec"]}

    async def update(self, owner, workflow_id, spec, *, restored_from=None):
        row = self._owned(owner, workflow_id)
        if row is None:
            return None
        latest = row["latest_version_no"]
        if self._canonical(self.versions[(workflow_id, latest)]["spec"]) != self._canonical(spec):
            latest += 1
            self.versions[(workflow_id, latest)] = {
                "version_no": latest, "spec": spec, "created_by": owner, "created_at": NOW,
                "restored_from": restored_from,
            }
        row.update(latest_version_no=latest, draft=spec, name=spec["name"], description=spec.get("description", ""))
        return latest

    async def list_versions(self, owner, workflow_id, *, limit, before=None):
        if self._owned(owner, workflow_id) is None:
            return None
        numbers = sorted(
            (n for (wid, n) in self.versions if wid == workflow_id and (before is None or n < before)), reverse=True
        )[:limit]
        rows = []
        for n in numbers:
            v = self.versions[(workflow_id, n)]
            rows.append({
                "version_no": n, "created_at": v["created_at"], "created_by": v["created_by"],
                "restored_from": v["restored_from"], "name": v["spec"].get("name", ""),
                "description": v["spec"].get("description", ""),
                "node_count": len(v["spec"].get("nodes", [])), "edge_count": len(v["spec"].get("edges", [])),
            })
        return rows

    async def get_version_detail(self, owner, workflow_id, version_no):
        if self._owned(owner, workflow_id) is None:
            return None
        v = self.versions.get((workflow_id, version_no))
        return None if v is None else copy.deepcopy(v)


@pytest.fixture
def store(wf, monkeypatch):
    fake = FakeVersionStore(wf.spec.canonical_json)

    async def no_catalogue():
        return None

    monkeypatch.setattr(wf.utils, "workflow_store", lambda: fake)
    monkeypatch.setattr(wf.utils, "_known_mcp_tool_names", no_catalogue)
    return fake


def _normalized(wf, raw: dict) -> dict:
    """A spec as a save stores it (the validator's model dump)."""
    spec, issues = wf.validator.validate_spec(raw)
    assert spec is not None, issues
    return spec.model_dump(mode="json")


def _three_versions(wf) -> list[dict]:
    first = _normalized(wf, _example())
    second = copy.deepcopy(first)
    second["name"] = "Renamed"
    third = copy.deepcopy(second)
    third["description"] = "A third take."
    return [first, second, third]


# -- routes ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_history_routes_are_internal_only(client):
    base = f"/workflows/u1/{WORKFLOW_ID}/versions"
    assert (await client.get(base)).status_code == 403
    assert (await client.get(f"{base}/1")).status_code == 403
    assert (await client.post(f"{base}/1/restore")).status_code == 403


@pytest.mark.asyncio
async def test_list_is_newest_first_paged_and_summarised(client, internal_headers, wf, store):
    store.seed(WORKFLOW_ID, "u1", _three_versions(wf))
    response = await client.get(f"/workflows/u1/{WORKFLOW_ID}/versions?limit=2", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert [v["version_no"] for v in body["items"]] == [3, 2]
    assert body["next_before"] == 2
    top = body["items"][0]
    assert top["name"] == "Renamed" and top["description"] == "A third take."
    assert top["node_count"] == len(_example()["nodes"]) and top["edge_count"] == len(_example()["edges"])
    assert top["created_by"] == "u1" and top["restored_from"] is None
    assert "spec" not in top

    response = await client.get(
        f"/workflows/u1/{WORKFLOW_ID}/versions?limit=2&before=2", headers=internal_headers
    )
    body = response.json()
    assert [v["version_no"] for v in body["items"]] == [1]
    assert body["next_before"] is None


@pytest.mark.asyncio
async def test_another_owner_gets_404_everywhere(client, internal_headers, wf, store):
    store.seed(WORKFLOW_ID, "u1", _three_versions(wf))
    base = f"/workflows/u2/{WORKFLOW_ID}/versions"
    assert (await client.get(base, headers=internal_headers)).status_code == 404
    assert (await client.get(f"{base}/1", headers=internal_headers)).status_code == 404
    assert (await client.post(f"{base}/1/restore", headers=internal_headers)).status_code == 404
    # The owner's own missing version is a 404 too; a bad number never reaches the store.
    assert (await client.get(f"/workflows/u1/{WORKFLOW_ID}/versions/9", headers=internal_headers)).status_code == 404
    assert (await client.get(f"/workflows/u1/{WORKFLOW_ID}/versions/0", headers=internal_headers)).status_code == 422


@pytest.mark.asyncio
async def test_one_version_carries_its_whole_spec(client, internal_headers, wf, store):
    versions = _three_versions(wf)
    store.seed(WORKFLOW_ID, "u1", versions)
    response = await client.get(f"/workflows/u1/{WORKFLOW_ID}/versions/1", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["version_no"] == 1 and body["spec"] == versions[0]


@pytest.mark.asyncio
async def test_a_legacy_spec_comes_back_normalized(client, internal_headers, wf, store):
    # Stored by an older engine: declared state (persist) and an assign block.
    legacy = _normalized(wf, _example())
    legacy["state"] = [{"name": "last_status", "type": "string", "reducer": "overwrite", "persist": True}]
    legacy["nodes"][1]["config"]["assign"] = {"last_status": "{{output.body.status}}"}
    store.seed(WORKFLOW_ID, "u1", [legacy])
    expected = _normalized(wf, legacy)
    assert "state" not in expected and "assign" not in expected["nodes"][1]["config"]

    body = (await client.get(f"/workflows/u1/{WORKFLOW_ID}", headers=internal_headers)).json()
    assert body["spec"] == expected and body["draft"] == expected
    body = (await client.get(f"/workflows/u1/{WORKFLOW_ID}/versions/1", headers=internal_headers)).json()
    assert body["spec"] == expected


@pytest.mark.asyncio
async def test_restore_appends_a_new_version_and_never_rewrites_history(client, internal_headers, wf, store):
    versions = _three_versions(wf)
    store.seed(WORKFLOW_ID, "u1", versions)
    response = await client.post(f"/workflows/u1/{WORKFLOW_ID}/versions/1/restore", headers=internal_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["latest_version_no"] == 4
    assert body["spec"] == versions[0] and body["draft"] == versions[0]
    assert body["name"] == versions[0]["name"]
    # Versions 1–3 are untouched; version 4 is the copy, marked as a restore.
    assert [store.versions[(WORKFLOW_ID, n)]["spec"] for n in (1, 2, 3)] == versions
    assert store.versions[(WORKFLOW_ID, 4)]["restored_from"] == 1

    listed = (await client.get(f"/workflows/u1/{WORKFLOW_ID}/versions", headers=internal_headers)).json()
    assert [(v["version_no"], v["restored_from"]) for v in listed["items"]] == [(4, 1), (3, None), (2, None), (1, None)]


@pytest.mark.asyncio
async def test_restoring_the_newest_spec_adds_no_version(client, internal_headers, wf, store):
    store.seed(WORKFLOW_ID, "u1", _three_versions(wf))
    response = await client.post(f"/workflows/u1/{WORKFLOW_ID}/versions/3/restore", headers=internal_headers)
    assert response.status_code == 200 and response.json()["latest_version_no"] == 3
    assert (WORKFLOW_ID, 4) not in store.versions


@pytest.mark.asyncio
async def test_a_version_that_no_longer_validates_is_refused_with_its_issues(client, internal_headers, wf, store):
    versions = _three_versions(wf)
    broken = copy.deepcopy(versions[0])
    broken["nodes"][1]["config"]["url"] = "{{input.nope}}"
    store.seed(WORKFLOW_ID, "u1", [broken, *versions[1:]])
    response = await client.post(f"/workflows/u1/{WORKFLOW_ID}/versions/1/restore", headers=internal_headers)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "can't be restored" in detail["message"]
    assert detail["errors"] and detail["errors"][0]["nodeId"] == "poll"
    assert set(detail["errors"][0]) == {"nodeId", "path", "message"}
    assert (WORKFLOW_ID, 4) not in store.versions
    assert store.rows[WORKFLOW_ID]["latest_version_no"] == 3


# -- the store's SQL, against Postgres ---------------------------------------------


@pytest.fixture(scope="module")
def event_loop_policy():
    """psycopg's async mode cannot run on Windows' default Proactor loop."""
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.DefaultEventLoopPolicy()


@pytest_asyncio.fixture
async def pg_store(agents_service):
    if not DSN or psycopg is None:
        pytest.skip("WORKFLOW_STORE_TEST_DSN is not set (or psycopg is missing)")

    database = f"workflow_store_test_{uuid.uuid4().hex[:8]}"
    async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
        await admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    pool = AsyncConnectionPool(
        conninfo.make_conninfo(DSN, dbname=database), min_size=1, max_size=4, open=False,
        kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None},
    )
    await pool.open()
    try:
        store = importlib.import_module("harness.workflows.store").WorkflowStore(pool)
        await store.setup()
        await store.setup()  # the DDL is idempotent
        yield store
    finally:
        await pool.close()
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


@pytest.mark.asyncio
async def test_store_history_against_postgres(pg_store, wf):
    versions = _three_versions(wf)
    workflow_id = await pg_store.create("u1", versions[0])
    assert await pg_store.update("u1", workflow_id, versions[1]) == 2
    assert await pg_store.update("u1", workflow_id, versions[2]) == 3

    page = await pg_store.list_versions("u1", workflow_id, limit=2)
    assert [r["version_no"] for r in page] == [3, 2]
    assert page[0]["name"] == "Renamed" and page[0]["description"] == "A third take."
    assert page[0]["node_count"] == len(versions[0]["nodes"]) and page[0]["edge_count"] == len(versions[0]["edges"])
    assert page[0]["created_by"] == "u1" and page[0]["restored_from"] is None
    assert [r["version_no"] for r in await pg_store.list_versions("u1", workflow_id, limit=2, before=2)] == [1]
    assert await pg_store.list_versions("u2", workflow_id, limit=10) is None

    detail = await pg_store.get_version_detail("u1", workflow_id, 1)
    assert detail["spec"] == versions[0] and detail["version_no"] == 1
    assert await pg_store.get_version_detail("u2", workflow_id, 1) is None
    assert await pg_store.get_version_detail("u1", workflow_id, 9) is None

    assert await pg_store.update("u1", workflow_id, versions[0], restored_from=1) == 4
    restored = await pg_store.get_version_detail("u1", workflow_id, 4)
    assert restored["restored_from"] == 1 and restored["spec"] == versions[0]
    assert (await pg_store.get_version_detail("u1", workflow_id, 1))["spec"] == versions[0]
    # The same spec again adds nothing.
    assert await pg_store.update("u1", workflow_id, versions[0], restored_from=1) == 4


@pytest.mark.asyncio
async def test_kept_values_round_trip_through_postgres(pg_store, wf):
    """jsonb comes back decoded: a kept string must not be parsed a second time."""
    workflow_id = await pg_store.create("u1", _example())
    kept = {"last_status": "healthy", "checks": 2, "last_rates": {"USD": 1.1}, "seen": ["a", "b"], "none": None}
    await pg_store.save_persisted("u1", workflow_id, kept)
    assert await pg_store.load_persisted("u1", workflow_id) == kept
