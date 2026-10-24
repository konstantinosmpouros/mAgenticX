"""The bridge's routes over a conversation's files (plan 43).

Keyed by user and conversation, never by agent. Pinned:

* the presented-file read returns ``/conversation/output/`` files only — an
  upload, an offload or a traversal comes back in ``missing``;
* a fork's copy and a deleted conversation's reap; a reap that could not
  finish answers 503, so the bridge's outbox keeps it;
* everything is internal-only;
* until the next release, a bridge from before plan 43 still gets a working
  answer on its agent-scoped routes.
"""
from __future__ import annotations

import base64

import psycopg
import pytest

pytestmark = pytest.mark.asyncio

FILES = "/users/u1/conversations/c1/files"


class _Checkpointer:
    def __init__(self, fail: bool = False):
        self.deleted: list[str] = []
        self._fail = fail

    async def adelete_thread(self, thread_id):
        if self._fail:
            raise psycopg.OperationalError("connection lost")
        self.deleted.append(thread_id)


@pytest.fixture
def files(agents_service, memory_file_store, monkeypatch):
    module = agents_service.conversation_files_utils
    monkeypatch.setattr(module, "_store", lambda: memory_file_store)
    return memory_file_store


async def test_presented_files_are_read_from_output_only(client, internal_headers, files):
    await files.create("u1", "c1", "/conversation/output/report.md", b"# Q3", agent_slug="omni")
    await files.create("u1", "c1", "/large_tool_results/call-1", b"internal", agent_slug="omni")
    asked = ["/conversation/output/report.md", "/large_tool_results/call-1",
             "/conversation/output/../../large_tool_results/call-1", "/conversation/output/nope.md"]

    response = await client.get(FILES, params=[("paths", p) for p in asked], headers=internal_headers)

    assert response.status_code == 200
    body = response.json()
    assert [(f["path"], f["filename"], base64.b64decode(f["base64"])) for f in body["files"]] == [
        ("/conversation/output/report.md", "report.md", b"# Q3"),
    ]
    assert sorted(body["missing"]) == sorted(asked[1:])


async def test_an_oversized_snapshot_is_skipped_and_too_many_paths_refused(client, internal_headers, files,
                                                                           agents_service, monkeypatch):
    fs = agents_service.settings_module.settings.filesystem
    monkeypatch.setattr(fs, "output_max_file_bytes", 3)
    await files.create("u1", "c1", "/conversation/output/big.md", b"four", agent_slug="omni")

    oversized = await client.get(FILES, params={"paths": "/conversation/output/big.md"}, headers=internal_headers)
    too_many = await client.get(FILES, params=[("paths", f"/conversation/output/{i}") for i in range(21)],
                                headers=internal_headers)

    assert oversized.json() == {"files": [], "missing": ["/conversation/output/big.md"]}
    assert too_many.status_code == 422


async def test_a_fork_gets_the_files(client, internal_headers, files):
    await files.create("u1", "c1", "/conversation/output/report.md", b"# Q3", agent_slug="omni")

    response = await client.post(f"{FILES}/copy", json={"target_conversation_id": "fork"}, headers=internal_headers)

    assert response.json() == {"copied": 1}
    assert await files.read("u1", "fork", "/conversation/output/report.md") == b"# Q3"


async def test_a_reap_drops_the_threads_and_every_file(client, internal_headers, files, agents_service, monkeypatch):
    checkpointer = _Checkpointer()
    monkeypatch.setattr(agents_service.conversation_files_utils, "get_checkpointer", lambda: checkpointer)
    await files.create("u1", "c1", "/conversation/output/a.md", b"a", agent_slug="omni")
    await files.create("u1", "c1", "/conversation_history/t1.md", b"h", agent_slug="nova")

    response = await client.post("/users/u1/conversations/c1/reap", json={"thread_ids": ["t1", "t2"]},
                                 headers=internal_headers)

    assert response.status_code == 204
    assert checkpointer.deleted == ["t1", "t2"]
    assert files.rows == {} and files.blobs == {}


async def test_an_unfinished_reap_answers_503_so_the_bridge_retries(client, internal_headers, files,
                                                                    agents_service, monkeypatch):
    monkeypatch.setattr(agents_service.conversation_files_utils, "get_checkpointer", lambda: _Checkpointer(fail=True))

    response = await client.post("/users/u1/conversations/c1/reap", json={"thread_ids": ["t1"]},
                                 headers=internal_headers)

    assert response.status_code == 503


async def test_the_routes_are_internal_only(client, files):
    assert (await client.get(FILES)).status_code == 403
    assert (await client.post(f"{FILES}/copy", json={"target_conversation_id": "x"})).status_code == 403
    assert (await client.post("/users/u1/conversations/c1/reap", json={})).status_code == 403


async def test_a_bridge_from_before_plan_43_still_gets_answers(client, internal_headers, files):
    """TODO(plan 43): remove with router/legacy_workspace.py."""
    await files.create("u1", "c1", "/conversation/output/report.md", b"# Q3", agent_slug="omni")
    old = "/agents/omni/users/u1/conversations/c1"

    seed = await client.put(f"{old}/input-files", json={"files": []}, headers=internal_headers)
    manifest = await client.get(f"{old}/output-files/manifest", headers=internal_headers)
    read = await client.get(f"{old}/output-files", params={"paths": "/conversation/output/report.md"},
                            headers=internal_headers)

    assert seed.status_code == 200 and manifest.json() == {"files": []}
    assert [f["filename"] for f in read.json()["files"]] == ["report.md"]
