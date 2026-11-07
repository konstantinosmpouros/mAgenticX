"""The branch scratch store — one shared filesystem per branch (plan 41 §3.7).

Pinned here:

* the **store contract** — last-write-wins ``put``, a compare-and-set that
  refuses a stale version, scoping by (user, conversation, branch),
  copy-on-fork, deletion by conversation and by user, the one-shot import —
  run against an in-memory twin *and* Postgres, so the two cannot drift;
* the **backend**: two backends on one branch (an orchestrator and its task,
  on different threads) see each other's writes live; another branch does
  not; ``edit_file`` fails cleanly when another agent changed the file;
* **which branch**: the run context's ``branch_thread_id``, else the run's
  ``thread_id`` — bound at build time or read from the live LangGraph run;
* **copy-on-fork** through ``harness.checkpointer.fork``;
* the **one-shot import** of legacy ``files`` checkpoint state: read through
  deepagents' own channel, idempotent, never overwriting the store;
* the **sandbox** default reads and writes the same rows.

The Postgres half needs a server: set ``CONVERSATION_FILES_TEST_DSN`` to a
maintenance-database URL (e.g. ``postgresql://admin:admin@localhost:5432/postgres``
for the local compose stack); a scratch database is created and dropped. It is
skipped otherwise.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib
import json
import os
import sys
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import TypedDict, get_type_hints

import httpx
import psycopg
import pytest
import pytest_asyncio
from deepagents.backends.protocol import SandboxBackendProtocol
from deepagents.backends.utils import create_file_data
from deepagents.middleware.filesystem import FilesystemState
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.serde.encrypted import EncryptedSerializer
from langgraph.graph import END, START, StateGraph
from psycopg import conninfo, sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

pytestmark = pytest.mark.asyncio

DSN = os.environ.get("CONVERSATION_FILES_TEST_DSN")
KEY = b"0123456789abcdef0123456789abcdef"
RUNNER_URL = "https://sandbox-runner.test:8090"

_FILES_CHANNEL = get_type_hints(FilesystemState, include_extras=True)["files"]
class _FilesState(TypedDict, total=False):
    files: _FILES_CHANNEL


def _mod(name: str):
    return importlib.import_module(name)


def _cipher(key: bytes | None):
    module = _mod("harness.conversation_files.cipher")
    if key is None:
        return module.FileCipher(None)
    return module.FileCipher(EncryptedSerializer.from_pycryptodome_aes(key=key).cipher)


# ---------------------------------------------------------------------------
# The store, in memory — the same contract as Postgres
# ---------------------------------------------------------------------------
class MemoryScratchStore:
    """``BranchScratchStore`` in memory, held to the Postgres contract below."""

    def __init__(self) -> None:
        self._m = _mod("harness.filesystem.scratch_store")
        self.rows: dict[tuple[str, str, str], dict] = {}
        self.imported: dict[tuple[str, str], str] = {}
        self.setups = 0

    async def ensure_setup(self):
        self.setups += 1

    def _entry(self, path, row):
        return self._m.ScratchEntry(path, len(row["data"]), row["sha256"], row["encoding"],
                                    row["created_at"], row["updated_at"])

    def _in_scope(self, scope):
        return {path: row for (conv, branch, path), row in self.rows.items()
                if (conv, branch, row["user_id"]) ==
                (scope.conversation_id, scope.branch_thread_id, scope.user_id)}

    def _checked(self, data, encoding):
        assert encoding in self._m.ENCODINGS
        cap = _mod("core.settings").settings.conversation_files.max_file_bytes
        if len(data) > cap:
            raise self._m.ScratchFileTooLarge("too large")

    async def list_files(self, scope, directory="/"):
        prefix = directory.rstrip("/") + "/"
        return [self._entry(p, r) for p, r in sorted(self._in_scope(scope).items())
                if p == directory or p.startswith(prefix)]

    async def get(self, scope, path):
        return (await self.read_many(scope, [path])).get(path)

    async def read_many(self, scope, file_paths):
        rows = self._in_scope(scope)
        return {p: self._m.ScratchFile(self._entry(p, rows[p]), rows[p]["data"]) for p in file_paths if p in rows}

    def _write(self, scope, path, data, encoding, agent_slug):
        key = (scope.conversation_id, scope.branch_thread_id, path)
        now = datetime.now(UTC)
        previous = self.rows.get(key)
        self.rows[key] = {
            "user_id": scope.user_id, "data": bytes(data), "encoding": encoding,
            "sha256": hashlib.sha256(data).hexdigest(), "agent_slug": agent_slug,
            "created_at": previous["created_at"] if previous else now, "updated_at": now,
        }
        return self.rows[key]["sha256"]

    async def put(self, scope, path, data, *, encoding, agent_slug):
        self._checked(data, encoding)
        existing = self.rows.get((scope.conversation_id, scope.branch_thread_id, path))
        if existing is not None and existing["user_id"] != scope.user_id:
            return None
        return self._write(scope, path, data, encoding, agent_slug)

    async def compare_and_set(self, scope, path, expected_sha256, data, *, encoding, agent_slug):
        self._checked(data, encoding)
        current = self._in_scope(scope).get(path)
        if current is None or current["sha256"] != expected_sha256:
            return None
        return self._write(scope, path, data, encoding, agent_slug)

    async def copy_branch(self, source_thread_id, target_thread_id):
        if not source_thread_id or not target_thread_id or source_thread_id == target_thread_id:
            return 0
        copied = 0
        for (conv, branch, path), row in list(self.rows.items()):
            if branch == source_thread_id and (conv, target_thread_id, path) not in self.rows:
                self.rows[(conv, target_thread_id, path)] = dict(row)
                copied += 1
        return copied

    async def delete_conversation(self, user_id, conversation_id):
        doomed = [k for k, r in self.rows.items() if k[0] == conversation_id and r["user_id"] == user_id]
        for key in doomed:
            del self.rows[key]
        for key in [k for k, u in self.imported.items() if k[0] == conversation_id and u == user_id]:
            del self.imported[key]
        return len(doomed)

    async def purge_user(self, user_id):
        doomed = [k for k, r in self.rows.items() if r["user_id"] == user_id]
        for key in doomed:
            del self.rows[key]
        for key in [k for k, u in self.imported.items() if u == user_id]:
            del self.imported[key]
        return {"branch_scratch_files": len(doomed)}

    async def is_imported(self, scope):
        return (scope.conversation_id, scope.branch_thread_id) in self.imported

    async def import_legacy(self, scope, files, *, agent_slug):
        inserted = 0
        for path, (data, encoding) in files.items():
            self._checked(data, encoding)
            if (scope.conversation_id, scope.branch_thread_id, path) not in self.rows:
                self._write(scope, path, data, encoding, agent_slug)
                inserted += 1
        self.imported.setdefault((scope.conversation_id, scope.branch_thread_id), scope.user_id)
        return inserted


@pytest.fixture(scope="module")
def event_loop_policy():
    """psycopg's async mode cannot run on Windows' default Proactor loop."""
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.DefaultEventLoopPolicy()


@pytest.fixture(autouse=True)
def _fresh_import_cache(agents_service):
    """The one-shot import remembers imported branches per process."""
    migration = _mod("harness.filesystem.scratch_migration")
    migration._IMPORTED.clear()
    yield
    migration._IMPORTED.clear()


@pytest.fixture
def memory_store(agents_service):
    return MemoryScratchStore()


@pytest_asyncio.fixture
async def pg_pool(agents_service):
    if not DSN:
        pytest.skip("CONVERSATION_FILES_TEST_DSN is not set")
    database = f"branch_scratch_test_{uuid.uuid4().hex[:8]}"
    async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
        await admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    target = conninfo.make_conninfo(DSN, dbname=database)
    pool = AsyncConnectionPool(target, min_size=1, max_size=4, open=False,
                               kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None})
    await pool.open()
    try:
        yield pool
    finally:
        await pool.close()
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


@pytest_asyncio.fixture
async def pg_store(pg_pool):
    store = _mod("harness.filesystem.scratch_store").BranchScratchStore(pg_pool, _cipher(KEY))
    await store.setup()
    await store.setup()  # idempotent
    return store


@pytest.fixture(params=["memory", "postgres"])
def store(request, memory_store):
    if request.param == "memory":
        return memory_store
    return request.getfixturevalue("pg_store")


def _scope(user="u1", conversation="c1", branch="b1"):
    return _mod("harness.filesystem.scratch_store").ScratchScope(user, conversation, branch)


# ---------------------------------------------------------------------------
# The store contract (memory and Postgres)
# ---------------------------------------------------------------------------
async def test_put_then_get_and_list_by_prefix(store):
    scope = _scope()
    for path in ["/notes.md", "/drafts/v1.md", "/drafts/deep/v2.md", "/drafts.md"]:
        await store.put(scope, path, path.encode(), encoding="utf-8", agent_slug="omni")

    under = [entry.path for entry in await store.list_files(scope, "/drafts")]
    file = await store.get(scope, "/notes.md")

    assert under == ["/drafts/deep/v2.md", "/drafts/v1.md"]
    assert len(await store.list_files(scope)) == 4
    assert file.data == b"/notes.md" and file.entry.sha256 == hashlib.sha256(b"/notes.md").hexdigest()


async def test_rows_never_cross_users_conversations_or_branches(store):
    await store.put(_scope(), "/a.md", b"mine", encoding="utf-8", agent_slug="omni")

    for other in (_scope(user="u2"), _scope(conversation="c2"), _scope(branch="b2")):
        assert await store.get(other, "/a.md") is None
        assert await store.list_files(other) == []
    # Another user can never overwrite the row at the same key.
    assert await store.put(_scope(user="u2"), "/a.md", b"theirs", encoding="utf-8", agent_slug="x") is None
    assert (await store.get(_scope(), "/a.md")).data == b"mine"


async def test_put_is_last_write_wins(store):
    scope = _scope()
    await store.put(scope, "/a.md", b"one", encoding="utf-8", agent_slug="omni")
    version = await store.put(scope, "/a.md", b"two", encoding="utf-8", agent_slug="helper")

    assert (await store.get(scope, "/a.md")).data == b"two"
    assert version == hashlib.sha256(b"two").hexdigest()


async def test_compare_and_set_refuses_a_stale_version(store):
    scope = _scope()
    first = await store.put(scope, "/a.md", b"v1", encoding="utf-8", agent_slug="omni")
    await store.put(scope, "/a.md", b"v2", encoding="utf-8", agent_slug="helper")  # someone else

    assert await store.compare_and_set(scope, "/a.md", first, b"v1-edit", encoding="utf-8", agent_slug="omni") is None
    current = await store.get(scope, "/a.md")
    assert current.data == b"v2"
    assert await store.compare_and_set(
        scope, "/a.md", current.entry.sha256, b"v2-edit", encoding="utf-8", agent_slug="omni"
    ) == hashlib.sha256(b"v2-edit").hexdigest()
    assert await store.compare_and_set(scope, "/none.md", first, b"x", encoding="utf-8", agent_slug="o") is None


async def test_copy_branch_gives_the_fork_the_files_and_then_they_diverge(store):
    source, fork = _scope(branch="b1"), _scope(branch="b2")
    await store.put(source, "/a.md", b"shared", encoding="utf-8", agent_slug="omni")
    await store.put(source, "/bin.dat", b"\x00\xff", encoding="base64", agent_slug="omni")

    assert await store.copy_branch("b1", "b2") == 2
    assert await store.copy_branch("b1", "b2") == 0  # a retried fork changes nothing
    await store.put(fork, "/a.md", b"forked", encoding="utf-8", agent_slug="omni")

    assert (await store.get(source, "/a.md")).data == b"shared"
    assert (await store.get(fork, "/a.md")).data == b"forked"
    assert (await store.get(fork, "/bin.dat")).entry.encoding == "base64"


async def test_conversation_delete_and_account_purge_take_only_their_own(store):
    await store.put(_scope(branch="b1"), "/a.md", b"a", encoding="utf-8", agent_slug="o")
    await store.put(_scope(branch="b2"), "/b.md", b"b", encoding="utf-8", agent_slug="o")
    await store.put(_scope(conversation="c2"), "/c.md", b"c", encoding="utf-8", agent_slug="o")
    await store.put(_scope(user="u2", conversation="c9"), "/d.md", b"d", encoding="utf-8", agent_slug="o")
    await store.import_legacy(_scope(branch="b1"), {}, agent_slug="o")

    assert await store.delete_conversation("u1", "c1") == 2
    assert not await store.is_imported(_scope(branch="b1"))
    assert await store.get(_scope(conversation="c2"), "/c.md") is not None
    assert await store.purge_user("u1") == {"branch_scratch_files": 1}
    assert (await store.get(_scope(user="u2", conversation="c9"), "/d.md")).data == b"d"


async def test_legacy_import_marks_the_branch_and_never_overwrites(store):
    scope = _scope()
    await store.put(scope, "/kept.md", b"newer", encoding="utf-8", agent_slug="omni")
    assert not await store.is_imported(scope)

    inserted = await store.import_legacy(
        scope, {"/kept.md": (b"older", "utf-8"), "/new.md": (b"legacy", "utf-8")}, agent_slug="omni"
    )

    assert inserted == 1 and await store.is_imported(scope)
    assert (await store.get(scope, "/kept.md")).data == b"newer"
    assert (await store.get(scope, "/new.md")).data == b"legacy"


async def test_a_file_over_the_cap_is_refused(store, agents_service, monkeypatch):
    module = _mod("harness.filesystem.scratch_store")
    monkeypatch.setattr(agents_service.settings_module.settings.conversation_files, "max_file_bytes", 4)
    with pytest.raises(module.ScratchFileTooLarge):
        await store.put(_scope(), "/a.md", b"12345", encoding="utf-8", agent_slug="o")
    assert await store.get(_scope(), "/a.md") is None


# ---------------------------------------------------------------------------
# Postgres only: what is actually stored
# ---------------------------------------------------------------------------
async def test_bytes_are_encrypted_at_rest_and_copied_as_ciphertext(pg_store, pg_pool):
    await pg_store.put(_scope(), "/secret.md", b"quarterly numbers", encoding="utf-8", agent_slug="omni")
    await pg_store.copy_branch("b1", "b2")

    async with pg_pool.connection() as conn:
        cur = await conn.execute("SELECT branch_thread_id, cipher, data FROM branch_scratch_files ORDER BY 1")
        rows = await cur.fetchall()

    assert [row["cipher"] for row in rows] == ["aes", "aes"]
    assert all(b"quarterly" not in bytes(row["data"]) for row in rows)
    assert (await pg_store.get(_scope(branch="b2"), "/secret.md")).data == b"quarterly numbers"


# ---------------------------------------------------------------------------
# Which branch
# ---------------------------------------------------------------------------
async def test_the_context_branch_wins_over_the_runs_own_thread(agents_service):
    resolve = _mod("harness.filesystem").resolve_branch_thread_id

    assert resolve({"branch_thread_id": "orch"}, {"configurable": {"thread_id": "task-1"}}) == "orch"
    assert resolve({"user_id": "u1"}, {"configurable": {"thread_id": "orch"}}) == "orch"
    assert resolve({"branch_thread_id": "  "}, {"configurable": {"thread_id": "orch"}}) == "orch"
    assert resolve(None, {"configurable": {}}) is None
    assert resolve(None, None) is None


async def test_an_ill_formed_branch_id_is_refused(agents_service, memory_store):
    backend_mod = _mod("harness.filesystem.scratch_backend")
    with pytest.raises(ValueError, match="branch thread"):
        backend_mod.BranchScratchBackend(store=memory_store, user_id="u1", conversation_id="c1",
                                         agent_slug="omni", branch_thread_id="../other")


def _backend(store, branch="b1", agent="omni"):
    return _mod("harness.filesystem.scratch_backend").BranchScratchBackend(
        store=store, user_id="u1", conversation_id="c1", agent_slug=agent, branch_thread_id=branch
    )


# ---------------------------------------------------------------------------
# The backend: one filesystem per branch, live
# ---------------------------------------------------------------------------
async def test_two_agents_on_one_branch_see_each_others_writes(memory_store):
    orchestrator, task = _backend(memory_store, agent="omni"), _backend(memory_store, agent="helper")

    assert (await orchestrator.awrite("/plan.md", "step 1\n")).error is None
    assert (await task.aread("/plan.md")).file_data["content"] == "step 1\n"
    assert (await task.awrite("/findings/a.md", "found TODO here\n")).error is None

    listing = await orchestrator.als("/")
    assert [e["path"] for e in listing.entries] == ["/findings/", "/plan.md"]
    assert [m["path"] for m in (await orchestrator.aglob("**/*.md")).matches] == ["/findings/a.md", "/plan.md"]
    grep = await orchestrator.agrep("TODO")
    assert [(m["path"], m["line"]) for m in grep.matches] == [("/findings/a.md", 1)]
    # Both backends ran the setup + one-shot import once for the branch.
    assert memory_store.setups == 2


async def test_two_agents_share_and_conflict_on_postgres(pg_store):
    orchestrator, task = _backend(pg_store, agent="omni"), _backend(pg_store, agent="helper")
    await orchestrator.awrite("/plan.md", "v1\n")
    await task.aread("/plan.md")
    await orchestrator.aedit("/plan.md", "v1", "v2")

    assert "changed by another agent" in (await task.aedit("/plan.md", "v1", "v3")).error
    assert (await task.aread("/plan.md")).file_data["content"] == "v2\n"
    assert (await task.aedit("/plan.md", "v2", "v3")).occurrences == 1
    assert (await orchestrator.aread("/plan.md")).file_data["content"] == "v3\n"


async def test_another_branch_sees_none_of_it(memory_store):
    await _backend(memory_store, branch="b1").awrite("/plan.md", "branch one")

    other = _backend(memory_store, branch="b2")
    assert (await other.aread("/plan.md")).error == "File '/plan.md' not found"
    assert (await other.als("/")).entries == []


async def test_an_edit_on_a_file_changed_by_another_agent_fails_cleanly(memory_store):
    orchestrator, task = _backend(memory_store, agent="omni"), _backend(memory_store, agent="helper")
    await orchestrator.awrite("/plan.md", "status: draft\n")
    await task.aread("/plan.md")
    await orchestrator.awrite("/plan.md", "status: review\n")  # the orchestrator moves on

    stale = await task.aedit("/plan.md", "status: draft", "status: done")
    assert stale.error is not None and "changed by another agent" in stale.error
    assert (await orchestrator.aread("/plan.md")).file_data["content"] == "status: review\n"

    await task.aread("/plan.md")  # re-read, then retry
    retried = await task.aedit("/plan.md", "status: review", "status: done")
    assert (retried.error, retried.occurrences) == (None, 1)
    assert (await orchestrator.aread("/plan.md")).file_data["content"] == "status: done\n"


async def test_a_write_that_lands_mid_edit_loses_the_compare_and_set(memory_store, monkeypatch):
    backend = _backend(memory_store)
    await backend.awrite("/a.md", "one\n")
    real = memory_store.compare_and_set

    async def racing(scope, path, expected, data, **kwargs):
        await memory_store.put(scope, path, b"someone else\n", encoding="utf-8", agent_slug="helper")
        return await real(scope, path, expected, data, **kwargs)

    monkeypatch.setattr(memory_store, "compare_and_set", racing)
    result = await backend.aedit("/a.md", "one", "two")

    assert "changed by another agent" in result.error
    assert (await memory_store.get(_scope(), "/a.md")).data == b"someone else\n"


async def test_edit_without_a_prior_read_and_binary_files(memory_store):
    backend = _backend(memory_store)
    other = _backend(memory_store, agent="helper")
    await other.awrite("/a.md", "alpha beta\n")

    assert (await backend.aedit("/a.md", "beta", "gamma")).occurrences == 1
    assert (await backend.aedit("/missing.md", "x", "y")).error == "Error: File '/missing.md' not found"

    [upload] = await backend.aupload_files([("/img.bin", b"\x89PNG\x00\xff")])
    assert upload.error is None
    assert "binary" in (await backend.aedit("/img.bin", "PNG", "JPG")).error
    [download] = await other.adownload_files(["/img.bin"])
    assert download.content == b"\x89PNG\x00\xff"


async def test_invalid_paths_never_reach_the_store(memory_store):
    backend = _backend(memory_store)
    assert "Error writing file" in (await backend.awrite("/../etc/passwd", "x")).error
    assert memory_store.rows == {}


async def test_the_live_run_decides_the_branch_when_none_is_bound(memory_store):
    """Unbound, the backend reads the branch from the running graph: the
    orchestrator's thread, or — on a task's own thread — the context's branch."""
    backend = _mod("harness.filesystem.scratch_backend").BranchScratchBackend(
        store=memory_store, user_id="u1", conversation_id="c1", agent_slug="omni"
    )

    async def write(state):
        await backend.awrite("/from-run.md", "hello")
        return {}

    builder = StateGraph(_FilesState)
    builder.add_node("write", write)
    builder.add_edge(START, "write")
    builder.add_edge("write", END)
    graph = builder.compile(checkpointer=InMemorySaver())

    await graph.ainvoke({}, {"configurable": {"thread_id": "orch-thread"}})
    await graph.ainvoke({}, {"configurable": {"thread_id": "task-thread"}},
                        context={"branch_thread_id": "orch-thread"})

    assert {key[1] for key in memory_store.rows} == {"orch-thread"}


async def test_a_thread_less_run_keeps_the_in_state_scratch(memory_store):
    backend = _mod("harness.filesystem.scratch_backend").BranchScratchBackend(
        store=memory_store, user_id="u1", conversation_id="c1", agent_slug="omni"
    )

    async def write(state):
        await backend.awrite("/eph.md", "in state")
        return {}

    builder = StateGraph(_FilesState)
    builder.add_node("write", write)
    builder.add_edge(START, "write")
    builder.add_edge("write", END)
    result = await builder.compile().ainvoke({})

    assert memory_store.rows == {}
    assert result["files"]["/eph.md"]["content"] == "in state"


# ---------------------------------------------------------------------------
# The one-shot import of legacy checkpoint state
# ---------------------------------------------------------------------------
async def _legacy_thread(saver, thread_id, *batches):
    """A thread whose ``files`` channel was written the way deepagents did."""
    steps = iter(batches)

    def write(state):
        return {"files": next(steps)}

    builder = StateGraph(_FilesState)
    builder.add_node("write", write)
    builder.add_edge(START, "write")
    builder.add_edge("write", END)
    graph = builder.compile(checkpointer=saver)
    for _ in batches:
        await graph.ainvoke({}, {"configurable": {"thread_id": thread_id}})


async def test_legacy_files_are_read_through_deepagents_channel(agents_service):
    migration = _mod("harness.filesystem.scratch_migration")
    saver = InMemorySaver()
    await _legacy_thread(saver, "legacy-1",
                         {"/a.md": create_file_data("first")},
                         {"/b.md": create_file_data("second"), "/a.md": create_file_data("first, edited")})

    files = await migration.read_legacy_files(saver, "legacy-1")

    assert {path: data["content"] for path, data in files.items()} == {
        "/a.md": "first, edited", "/b.md": "second",
    }
    assert await migration.read_legacy_files(saver, "no-such-thread") == {}


async def test_legacy_rows_skip_what_cannot_be_stored(agents_service):
    migration = _mod("harness.filesystem.scratch_migration")
    rows, skipped = migration.legacy_to_rows({
        "/ok.md": create_file_data("text"),
        "/img.png": create_file_data(base64.b64encode(b"\x89PNG").decode(), encoding="base64"),
        "/legacy-lines.md": {"content": ["line 1", "line 2"], "encoding": "utf-8"},
        "/.hidden/x": create_file_data("hidden"),
        "/bad.bin": {"content": "!!not base64!!", "encoding": "base64"},
        "/deleted.md": None,
    })

    assert rows == {
        "/ok.md": (b"text", "utf-8"),
        "/img.png": (b"\x89PNG", "base64"),
        "/legacy-lines.md": (b"line 1\nline 2", "utf-8"),
    }
    assert skipped == 2


async def test_the_first_use_of_a_branch_imports_its_checkpoint_files_once(memory_store, monkeypatch):
    saver = InMemorySaver()
    await _legacy_thread(saver, "b1", {"/old.md": create_file_data("from the checkpoint"),
                                       "/both.md": create_file_data("checkpoint copy")})
    monkeypatch.setattr(_mod("harness.checkpointer.store"), "_checkpointer", saver)
    await memory_store.put(_scope(), "/both.md", b"store copy", encoding="utf-8", agent_slug="omni")

    first = _backend(memory_store)
    assert (await first.aread("/old.md")).file_data["content"] == "from the checkpoint"
    assert (await first.aread("/both.md")).file_data["content"] == "store copy"  # never overwritten
    assert memory_store.imported == {("c1", "b1"): "u1"}

    # Idempotent: a new run (new backend, cache cleared) finds the marker and
    # imports nothing, even after the file was changed in the store.
    await first.awrite("/old.md", "changed after the import")
    _mod("harness.filesystem.scratch_migration")._IMPORTED.clear()
    again = _backend(memory_store, agent="helper")
    assert (await again.aread("/old.md")).file_data["content"] == "changed after the import"


async def test_a_failed_import_leaves_the_branch_unmarked_and_usable(memory_store, monkeypatch):
    class _BrokenSaver:
        async def aget_tuple(self, config):
            raise ValueError("unreadable checkpoint")

    monkeypatch.setattr(_mod("harness.checkpointer.store"), "_checkpointer", _BrokenSaver())
    backend = _backend(memory_store)

    assert (await backend.awrite("/a.md", "works anyway")).error is None
    assert memory_store.imported == {}


# ---------------------------------------------------------------------------
# Copy-on-fork
# ---------------------------------------------------------------------------
class _ForkGraph:
    def __init__(self, states):
        self._states = states
        self.updated: list = []
        self.checkpointer = None

    async def aget_state(self, cfg):
        conf = cfg["configurable"]
        return self._states.get((conf["thread_id"], conf.get("checkpoint_id")), SimpleNamespace(values={}))

    async def aupdate_state(self, cfg, values, as_node=None):
        self.updated.append((cfg["configurable"]["thread_id"], values))


async def test_a_fork_copies_the_source_branchs_scratch(memory_store, monkeypatch):
    fork = _mod("harness.checkpointer.fork")
    monkeypatch.setattr(fork, "BranchScratchStore", lambda: memory_store)
    await memory_store.put(_scope(branch="src"), "/notes.md", b"before the fork", encoding="utf-8", agent_slug="o")
    graph = _ForkGraph({("src", "cp-1"): SimpleNamespace(values={"messages": ["m"]})})

    assert await fork.seed_thread_from_checkpoint(
        graph=graph, source_thread_id="src", source_checkpoint_id="cp-1", target_thread_id="new"
    )
    assert (await memory_store.get(_scope(branch="new"), "/notes.md")).data == b"before the fork"

    # An already-seeded target still gets (only) the files it lacks.
    await memory_store.put(_scope(branch="new"), "/notes.md", b"edited on the fork", encoding="utf-8", agent_slug="o")
    await memory_store.put(_scope(branch="src"), "/later.md", b"later", encoding="utf-8", agent_slug="o")
    seeded = _ForkGraph({("new", None): SimpleNamespace(values={"messages": ["m"]})})
    assert await fork.seed_thread_from_checkpoint(
        graph=seeded, source_thread_id="src", source_checkpoint_id="cp-1", target_thread_id="new"
    )
    assert (await memory_store.get(_scope(branch="new"), "/notes.md")).data == b"edited on the fork"
    assert (await memory_store.get(_scope(branch="new"), "/later.md")).data == b"later"


async def test_a_fork_against_postgres(pg_store, pg_pool, monkeypatch):
    fork = _mod("harness.checkpointer.fork")
    monkeypatch.setattr(fork, "BranchScratchStore", lambda: pg_store)
    _mod("harness.memory.pool").set_memory_pool(pg_pool)
    await pg_store.put(_scope(branch="src"), "/notes.md", b"n", encoding="utf-8", agent_slug="o")

    assert await fork.copy_branch_scratch("src", "dst") == 1
    assert (await pg_store.get(_scope(branch="dst"), "/notes.md")).data == b"n"


async def test_a_fork_without_a_store_still_seeds(agents_service, monkeypatch):
    fork = _mod("harness.checkpointer.fork")
    _mod("harness.memory.pool").set_memory_pool(None)
    graph = _ForkGraph({("src", "cp-1"): SimpleNamespace(values={"messages": ["m"]})})

    assert await fork.seed_thread_from_checkpoint(
        graph=graph, source_thread_id="src", source_checkpoint_id="cp-1", target_thread_id="new"
    )
    assert graph.updated == [("new", {"messages": ["m"]})]


# ---------------------------------------------------------------------------
# The workspace and the sandbox default
# ---------------------------------------------------------------------------
def _files(conversation="c1"):
    package = _mod("harness.conversation_files")
    return package.ConversationFiles(
        user_id="u1", conversation_id=conversation, agent_slug="omni", store=package.ConversationFileStore(object())
    )


async def test_the_workspace_default_is_the_branch_scratch_store(agents_service, skills_fs):
    workspace = _mod("harness.filesystem.workspace")
    backend = workspace.build_workspace_backend(
        user_id="u1", agent_slug="omni", files=_files(), use_memory=False, branch_thread_id="orch"
    )(None)

    default = backend.default
    assert type(default) is workspace.BranchScratchBackend
    assert not isinstance(default, SandboxBackendProtocol)
    assert (default._user_id, default._conversation_id, default._branch) == ("u1", "c1", "orch")


class _Runner:
    def __init__(self):
        self.bodies: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"exit_code": 0, "stdout": "ok\n", "stderr": "", "truncated": False,
                                         "duration_ms": 1, "killed_reason": None})


async def test_the_sandbox_default_reads_and_writes_the_same_rows(agents_service, skills_fs, memory_store,
                                                                   monkeypatch):
    fs = agents_service.settings_module.settings.filesystem
    fs.sandbox_execution_enabled, fs.sandbox_runner_url = True, RUNNER_URL
    workspace = _mod("harness.filesystem.workspace")
    sandbox = _mod("harness.filesystem.sandbox_backend")
    runner = _Runner()

    class _Wired(sandbox.RemoteSandboxBackend):
        def __init__(self, **kwargs):
            kwargs["scratch_store"] = memory_store
            super().__init__(**kwargs, transport=httpx.MockTransport(runner),
                             async_transport=httpx.MockTransport(runner))

    monkeypatch.setattr(workspace, "RemoteSandboxBackend", _Wired)
    composite = workspace.build_workspace_backend(
        user_id="u1", agent_slug="omni", files=_files(), use_memory=False, branch_thread_id="orch"
    )(None)
    assert isinstance(composite.default, sandbox.RemoteSandboxBackend)
    assert isinstance(composite.default, workspace.BranchScratchBackend)

    await composite.awrite("/plan.md", "from the sandbox default")
    task = _backend(memory_store, branch="orch", agent="helper")
    assert (await task.aread("/plan.md")).file_data["content"] == "from the sandbox default"
    await task.awrite("/plan.md", "from a task")
    assert (await composite.aread("/plan.md")).file_data["content"] == "from a task"

    # `execute` is unchanged: identity from the run, no scratch file shipped.
    sandbox_only = sandbox.RemoteSandboxBackend(
        user_id="u1", agent_slug="omni", conversation_id="c1", scratch_store=memory_store,
        branch_thread_id="orch", runner_url=RUNNER_URL,
        transport=httpx.MockTransport(runner), async_transport=httpx.MockTransport(runner),
    )
    result = await sandbox_only.aexecute("ls")
    assert result.exit_code == 0
    [body] = runner.bodies
    assert "files" not in body and body["conversation_id"] == "c1"
