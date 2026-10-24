"""Account deletion (plan 32) — the agents service's part of the purge.

Pins what the bridge relies on:

* each store deletes **all** of a user's rows, scoped to that user only, and the
  skill pool is really deleted (not tombstoned) — conversation files and their
  blobs included, by user id alone;
* the old workspace folder goes, and a malformed user id can never reach the disk;
* checkpoint threads are deleted, and a failure surfaces (503) instead of being
  swallowed, so the bridge retries rather than recording success;
* the routes are internal-only.
"""
from __future__ import annotations

import psycopg
import pytest


class _Cursor:
    def __init__(self, rowcount: int):
        self.rowcount = rowcount


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _Conn:
    def __init__(self, owner: "FakePool"):
        self._owner = owner

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def transaction(self):
        self._owner.transactions += 1
        return _Transaction()

    async def execute(self, sql, params=None):
        self._owner.calls.append((" ".join(sql.split()), params))
        return _Cursor(self._owner.rowcount)


class FakePool:
    """Records every statement; each DELETE reports ``rowcount`` rows."""

    def __init__(self, rowcount: int = 3):
        self.calls: list[tuple[str, object]] = []
        self.transactions = 0
        self.rowcount = rowcount

    def connection(self):
        return _Conn(self)


# -- the stores ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_skill_store_purge_deletes_every_skill_table_for_that_user_only(agents_service):
    pool = FakePool()
    counts = await agents_service.skill_store.SkillStore(pool).purge_user("u1")

    assert counts == {"agent_skills": 3, "skill_files": 3, "skill_pool": 3}
    assert pool.transactions == 1
    statements = [sql for sql, _ in pool.calls]
    assert statements == [
        "DELETE FROM agent_skills WHERE user_id = %s",
        "DELETE FROM skill_files WHERE user_id = %s",
        "DELETE FROM skill_pool WHERE user_id = %s",  # a real delete, not a tombstone
    ]
    assert all(params == ("u1",) for _, params in pool.calls)


@pytest.mark.asyncio
async def test_definition_store_purge_deletes_definitions_and_files(agents_service):
    pool = FakePool(rowcount=2)
    counts = await agents_service.definition_store.AgentDefinitionStore(pool).purge_user("u1")

    assert counts == {"agent_definitions": 2, "agent_definition_files": 2}
    assert pool.transactions == 1
    assert {sql for sql, _ in pool.calls} == {
        "DELETE FROM agent_definition_files WHERE user_id = %s",
        "DELETE FROM agent_definitions WHERE user_id = %s",
    }


@pytest.mark.asyncio
async def test_memory_store_purge_deletes_every_memory_of_that_user(agents_service):
    pool = FakePool(rowcount=7)
    removed = await agents_service.memory_store.AgentMemoryStore(pool).purge_user("u1")

    assert removed == 7
    assert pool.calls == [("DELETE FROM agent_memories WHERE user_id = %s", ("u1",))]


@pytest.mark.asyncio
async def test_conversation_file_store_purge_deletes_every_file_and_blob_of_that_user(agents_service):
    pool = FakePool(rowcount=4)
    counts = await agents_service.conversation_files.ConversationFileStore(pool).purge_user("u1")

    assert counts == {"conversation_files": 4, "conversation_file_blobs": 4}
    assert pool.transactions == 1
    assert pool.calls == [
        ("DELETE FROM conversation_files WHERE user_id = %s", ("u1",)),
        ("DELETE FROM conversation_file_blobs WHERE user_id = %s", ("u1",)),
    ]


# -- purge_user: rows, folder, cache ---------------------------------------------


@pytest.fixture
def purge(agents_service, monkeypatch):
    """utils.account_purge on a recording pool."""
    mod = agents_service.account_purge
    pool = FakePool(rowcount=1)
    monkeypatch.setattr(mod, "get_memory_pool", lambda: pool)
    mod.pool = pool
    return mod


@pytest.mark.asyncio
async def test_purge_user_removes_rows_folder_and_cached_agents(purge, skills_fs, agents_service):
    workspace = skills_fs.users_root / "u1"
    (workspace / "agents" / "a" / "conversations" / "c1" / "output").mkdir(parents=True)
    (workspace / "agents" / "a" / "conversations" / "c1" / "output" / "report.md").write_text("x")
    other = skills_fs.users_root / "u2"
    other.mkdir(parents=True)
    cache = agents_service.agents_utils._USER_AGENT_CACHE
    cache[("u1", "mine")] = (None, object())
    cache[("u2", "theirs")] = (None, object())
    try:
        counts = await purge.purge_user("u1")

        assert counts["workspace_removed"] is True
        assert not workspace.exists()
        assert other.exists()                                   # another user's folder is untouched
        assert ("u1", "mine") not in cache and ("u2", "theirs") in cache
        assert counts["agent_memories"] == 1 and counts["skill_pool"] == 1 and counts["agent_definitions"] == 1
        assert counts["conversation_files"] == 1 and counts["conversation_file_blobs"] == 1
        # Idempotent: the second call finds nothing on disk and still succeeds.
        again = await purge.purge_user("u1")
        assert again["workspace_removed"] is False
    finally:
        cache.pop(("u2", "theirs"), None)


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["../u2", "a/b", "..", ".hidden", ""])
async def test_purge_user_refuses_an_id_that_could_leave_users_folder(purge, skills_fs, bad):
    with pytest.raises(ValueError):
        await purge.purge_user(bad)
    assert purge.pool.calls == []                               # nothing deleted before the check


# -- checkpoint threads ------------------------------------------------------------


class _Checkpointer:
    def __init__(self, fail_on: str | None = None):
        self.deleted: list[str] = []
        self._fail_on = fail_on

    async def adelete_thread(self, thread_id):
        if thread_id == self._fail_on:
            raise psycopg.OperationalError("connection lost")
        self.deleted.append(thread_id)


@pytest.mark.asyncio
async def test_threads_route_deletes_each_thread(client, internal_headers, agents_service, monkeypatch):
    cp = _Checkpointer()
    monkeypatch.setattr(agents_service.account_purge, "get_checkpointer", lambda: cp)

    resp = await client.post("/users/u1/purge/threads", json={"thread_ids": ["t1", "t2"]}, headers=internal_headers)

    assert resp.status_code == 200 and resp.json() == {"deleted": 2}
    assert cp.deleted == ["t1", "t2"]


@pytest.mark.asyncio
async def test_a_failed_thread_delete_answers_503_so_the_bridge_retries(client, internal_headers, agents_service, monkeypatch):
    monkeypatch.setattr(agents_service.account_purge, "get_checkpointer", lambda: _Checkpointer(fail_on="t2"))

    resp = await client.post("/users/u1/purge/threads", json={"thread_ids": ["t1", "t2"]}, headers=internal_headers)

    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_an_oversized_thread_batch_is_refused(client, internal_headers):
    resp = await client.post(
        "/users/u1/purge/threads", json={"thread_ids": [f"t{i}" for i in range(501)]}, headers=internal_headers
    )
    assert resp.status_code == 422


# -- the routes are internal-only --------------------------------------------------


@pytest.mark.asyncio
async def test_purge_routes_refuse_callers_without_the_internal_secret(client, purge):
    assert (await client.delete("/users/u1")).status_code == 403
    assert (await client.post("/users/u1/purge/threads", json={"thread_ids": []})).status_code == 403
    assert purge.pool.calls == []


@pytest.mark.asyncio
async def test_delete_route_reports_what_was_removed(client, internal_headers, purge, skills_fs):
    resp = await client.delete("/users/u1", headers=internal_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {
        "agent_memories", "skill_pool", "skill_files", "agent_skills",
        "agent_definitions", "agent_definition_files",
        "conversation_files", "conversation_file_blobs", "workspace_removed",
    }
