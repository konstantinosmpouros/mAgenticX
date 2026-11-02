"""``AgentDefinitionStore`` version history — the real store over in-memory tables.

``test_agent_definition_store.py`` replays canned rows, which pins statement
shapes but cannot follow a history across saves. The rules here are about
sequences — create then edit then edit, an agent that predates history, the
21st save — so the pool below keeps the three tables as dicts and answers the
handful of statements the store issues, by their leading text. A statement it
does not recognise fails the test rather than returning nothing, so a new query
cannot slip past unexercised.

Pinned:

* first save → v1 ``created``; an edit → the next number, ``saved``, with the
  parts it changed; a save that changes nothing adds no version;
* an agent saved before history existed gets its old state as v1 ``baseline``;
* past ``MAX_VERSIONS`` the oldest go;
* a save with ``restored_from`` adds no version: it moves the ``current``
  pointer to that version; the next save is ``max + 1``, ``based_on`` the
  restored version, its changes measured against the restored state;
* ``current`` falls back to the newest when the pointer is NULL or pruned;
* delete and purge take the history with them; export pages every version.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)
USER = "u1"
SLUG = "nova"


_SUMMARY = ("version_no", "kind", "changes", "restored_from", "based_on", "created_at")


class _Cursor:
    def __init__(self, rows=(), rowcount=0):
        self._rows = list(rows)
        self.rowcount = rowcount

    async def fetchone(self):
        return self._rows[0] if self._rows else None

    async def fetchall(self):
        return list(self._rows)


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _Conn:
    def __init__(self, db):
        self._db = db

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def transaction(self):
        return _Transaction()

    async def execute(self, sql, params=()):
        return self._db.run(" ".join(sql.split()), params)


class TablePool:
    """``agent_definitions``, ``agent_definition_files`` and
    ``agent_definition_versions`` as dicts, behind the pool interface.

    jsonb columns are kept decoded, as psycopg hands them back.
    """

    def __init__(self):
        self.specs: dict[tuple[str, str], dict] = {}
        self.files: dict[tuple[str, str, str], tuple[str, str]] = {}
        self.versions: dict[tuple[str, str, int], dict] = {}
        # ``agent_definitions.current_version``; NULL (None) means the newest.
        self.current: dict[tuple[str, str], int | None] = {}

    def connection(self):
        return _Conn(self)

    # -- helpers ---------------------------------------------------------
    def kept(self, user=USER, slug=SLUG):
        return sorted(n for (u, s, n) in self.versions if (u, s) == (user, slug))

    def pointer(self, user=USER, slug=SLUG):
        return self.current.get((user, slug))

    def _version_row(self, key, columns):
        row = self.versions[key]
        return {c: row[c] for c in columns}

    # -- the statements the store issues ---------------------------------
    def run(self, sql, params):  # noqa: C901 — one branch per statement
        if sql.startswith("SELECT spec FROM agent_definitions"):
            spec = self.specs.get(params)
            return _Cursor([] if spec is None else [{"spec": spec}])
        if sql.startswith("SELECT path, content, encoding FROM agent_definition_files"):
            user, slug = params
            return _Cursor(
                {"path": p, "content": c, "encoding": e}
                for (u, s, p), (c, e) in sorted(self.files.items()) if (u, s) == (user, slug)
            )
        if sql.startswith("INSERT INTO agent_definitions"):
            user, slug, spec = params
            existed = (user, slug) in self.specs
            if "DO NOTHING" in sql:
                if existed:
                    return _Cursor([])
                self.specs[(user, slug)] = json.loads(spec)
                self.current[(user, slug)] = None
                return _Cursor([{"agent_slug": slug}])
            self.specs[(user, slug)] = json.loads(spec)
            if not existed:
                self.current[(user, slug)] = None
            return _Cursor([{"replaced": existed}])
        if sql.startswith("DELETE FROM agent_definition_files WHERE user_id = %s AND agent_slug = %s"):
            return self._delete(self.files, params)
        if sql.startswith("INSERT INTO agent_definition_files"):
            user, slug, path, content, encoding = params
            self.files[(user, slug, path)] = (content, encoding)
            return _Cursor()
        if sql.startswith("SELECT max(v.version_no) AS last, max(d.current_version) AS current"):
            numbers = self.kept(*params)
            if not numbers:   # aggregates over no rows: one row, both NULL
                return _Cursor([{"last": None, "current": None}])
            return _Cursor([{"last": numbers[-1], "current": self.current.get(tuple(params))}])
        if sql.startswith("UPDATE agent_definitions SET current_version = %s"):
            number, user, slug = params
            if (user, slug) not in self.specs:
                return _Cursor(rowcount=0)
            self.current[(user, slug)] = number
            return _Cursor(rowcount=1)
        if sql.startswith("INSERT INTO agent_definition_versions"):
            assert "based_on" in sql and "restored_from" not in sql
            user, slug, number, kind, changes, based_on, spec, files = params
            assert (user, slug, number) not in self.versions, "version number reused"
            self.versions[(user, slug, number)] = {
                "agent_slug": slug, "version_no": number, "kind": kind,
                "changes": json.loads(changes), "restored_from": None, "based_on": based_on,
                "created_at": NOW, "spec": json.loads(spec), "files": json.loads(files),
            }
            return _Cursor()
        if sql.startswith("DELETE FROM agent_definition_versions WHERE user_id = %s AND agent_slug = %s AND version_no <= %s"):
            user, slug, upto = params
            doomed = [k for k in self.versions if k[:2] == (user, slug) and k[2] <= upto]
            for key in doomed:
                del self.versions[key]
            return _Cursor(rowcount=len(doomed))
        if sql.startswith(
            "SELECT v.version_no, v.kind, v.changes, v.restored_from, v.based_on, "
            "v.created_at, d.current_version"
        ):
            pointer = self.current.get(tuple(params))
            return _Cursor(
                {**self._version_row((*params, n), _SUMMARY), "current_version": pointer}
                for n in reversed(self.kept(*params))
            )
        if sql.startswith("SELECT version_no, kind, changes, restored_from, based_on, created_at, spec, files"):
            key = tuple(params)
            if key not in self.versions:
                return _Cursor([])
            return _Cursor([self._version_row(key, (*_SUMMARY, "spec", "files"))])
        if sql.startswith("SELECT agent_slug, version_no, kind"):
            user, after_slug, after_no, limit = params
            keys = sorted(k for k in self.versions if k[0] == user and (k[1], k[2]) > (after_slug, after_no))
            return _Cursor(dict(self.versions[k]) for k in keys[:limit])
        if sql.startswith("DELETE FROM agent_definitions WHERE user_id = %s AND agent_slug = %s"):
            self._delete(self.current, params)
            return self._delete(self.specs, params)
        if sql.startswith("DELETE FROM agent_definition_versions WHERE user_id = %s AND agent_slug = %s"):
            return self._delete(self.versions, params)
        if sql.startswith("DELETE FROM agent_definitions WHERE user_id = %s"):
            self._delete(self.current, params)
            return self._delete(self.specs, params)
        if sql.startswith("DELETE FROM agent_definition_files WHERE user_id = %s"):
            return self._delete(self.files, params)
        if sql.startswith("DELETE FROM agent_definition_versions WHERE user_id = %s"):
            return self._delete(self.versions, params)
        raise AssertionError(f"unexpected statement: {sql}")

    @staticmethod
    def _delete(table, prefix):
        doomed = [k for k in table if k[: len(prefix)] == tuple(prefix)]
        for key in doomed:
            del table[key]
        return _Cursor(rowcount=len(doomed))


@pytest.fixture()
def pool():
    return TablePool()


@pytest.fixture()
def store(agents_service, pool):
    return agents_service.definition_store.AgentDefinitionStore(pool)


def _spec(**overrides):
    return {"slug": SLUG, "name": "Nova", "prompt": "./AGENT.md", "model": {"main": "openai:gpt-5"}, **overrides}


def _files(prompt="You are Nova.", **extra):
    return {"AGENT.md": (prompt, "utf-8"), **{k: (v, "utf-8") for k, v in extra.items()}}


async def _history(store):
    return [(v["version_no"], v["kind"], v["changes"]) for v in await store.list_versions(USER, SLUG)]


async def _current(store):
    return [v["version_no"] for v in await store.list_versions(USER, SLUG) if v["current"]]


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_the_first_save_is_version_one_created(store):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    assert await _history(store) == [(1, "created", [])]


@pytest.mark.asyncio
async def test_an_edit_is_the_next_version_with_what_it_changed(store):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(name="Nova 2"), files=_files("You are Nova, 2."))
    assert await _history(store) == [(2, "saved", ["details", "instructions"]), (1, "created", [])]


@pytest.mark.asyncio
async def test_a_save_that_changes_nothing_adds_no_version(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files())
    assert pool.kept() == [1]


@pytest.mark.asyncio
async def test_an_agent_from_before_history_gets_a_baseline_first(store, pool):
    # Saved before the versions table existed: a definition, no history.
    pool.specs[(USER, SLUG)] = _spec()
    pool.files[(USER, SLUG, "AGENT.md")] = ("You are Nova.", "utf-8")

    await store.save(USER, SLUG, spec=_spec(), files=_files("Sharper."))

    assert await _history(store) == [(2, "saved", ["instructions"]), (1, "baseline", [])]
    baseline = await store.get_version(USER, SLUG, 1)
    assert baseline["files"] == {"AGENT.md": ("You are Nova.", "utf-8")}   # the old state, undoable


@pytest.mark.asyncio
async def test_a_no_op_first_save_after_history_began_keeps_only_the_baseline(store, pool):
    pool.specs[(USER, SLUG)] = _spec()
    pool.files[(USER, SLUG, "AGENT.md")] = ("You are Nova.", "utf-8")
    await store.save(USER, SLUG, spec=_spec(), files=_files())
    assert await _history(store) == [(1, "baseline", [])]


@pytest.mark.asyncio
async def test_only_the_last_twenty_are_kept(agents_service, store, pool):
    cap = agents_service.agent_versions.MAX_VERSIONS
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    for n in range(2, cap + 6):
        await store.save(USER, SLUG, spec=_spec(), files=_files(f"Take {n}."))
    assert pool.kept() == list(range(6, cap + 6))
    assert len(pool.kept()) == cap


@pytest.mark.asyncio
async def test_each_save_is_based_on_the_one_before(store):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Two."))
    await store.save(USER, SLUG, spec=_spec(), files=_files("Three."))
    rows = await store.list_versions(USER, SLUG)
    assert [(v["version_no"], v["based_on"], v["current"]) for v in rows] == [
        (3, 2, True), (2, 1, False), (1, None, False),
    ]
    assert all("current_version" not in v for v in rows)


@pytest.mark.asyncio
async def test_a_baseline_save_is_based_on_the_baseline(store, pool):
    pool.specs[(USER, SLUG)] = _spec()
    pool.files[(USER, SLUG, "AGENT.md")] = ("You are Nova.", "utf-8")
    await store.save(USER, SLUG, spec=_spec(), files=_files("Sharper."))
    rows = await store.list_versions(USER, SLUG)
    assert [(v["version_no"], v["based_on"]) for v in rows] == [(2, 1), (1, None)]
    assert pool.pointer() == 2


@pytest.mark.asyncio
async def test_a_restore_adds_no_version_and_moves_current(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."))
    await store.save(USER, SLUG, spec=_spec(), files=_files(), restored_from=1)

    assert pool.kept() == [1, 2]
    assert pool.pointer() == 1
    assert await _current(store) == [1]
    # The agent itself holds the restored content.
    assert pool.files[(USER, SLUG, "AGENT.md")] == ("You are Nova.", "utf-8")


@pytest.mark.asyncio
async def test_a_save_after_a_restore_is_max_plus_one_based_on_the_restored(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(name="Nova 2"), files=_files("Changed."))
    await store.save(USER, SLUG, spec=_spec(), files=_files("Three."))
    await store.save(USER, SLUG, spec=_spec(), files=_files(), restored_from=1)

    # Only the name differs from v1 — v2/v3's instruction edits are not counted.
    await store.save(USER, SLUG, spec=_spec(name="Nova again"), files=_files())

    [latest, *_] = await store.list_versions(USER, SLUG)
    assert (latest["version_no"], latest["kind"], latest["based_on"]) == (4, "saved", 1)
    assert latest["changes"] == ["details"]
    assert latest["current"] is True
    assert pool.pointer() == 4


@pytest.mark.asyncio
async def test_a_no_op_save_after_a_restore_keeps_the_restored_version_current(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."))
    await store.save(USER, SLUG, spec=_spec(), files=_files(), restored_from=1)
    await store.save(USER, SLUG, spec=_spec(), files=_files())
    assert pool.kept() == [1, 2]
    assert await _current(store) == [1]


@pytest.mark.asyncio
async def test_restoring_the_previously_current_version_undoes_a_restore(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."))
    before = await store.list_versions(USER, SLUG)

    await store.save(USER, SLUG, spec=_spec(), files=_files(), restored_from=1)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."), restored_from=2)

    assert await store.list_versions(USER, SLUG) == before
    assert pool.files[(USER, SLUG, "AGENT.md")] == ("Changed.", "utf-8")


@pytest.mark.asyncio
async def test_current_falls_back_to_the_newest_when_the_pointer_is_null(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."))
    pool.current[(USER, SLUG)] = None     # a row from before the column existed
    assert await _current(store) == [2]


@pytest.mark.asyncio
async def test_current_falls_back_to_the_newest_when_the_pointer_is_pruned(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."))
    pool.current[(USER, SLUG)] = 99       # names a version no longer kept
    assert await _current(store) == [2]


@pytest.mark.asyncio
async def test_a_save_on_a_null_pointer_is_based_on_the_newest(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."))
    pool.current[(USER, SLUG)] = None
    await store.save(USER, SLUG, spec=_spec(), files=_files("Again."))
    [latest, *_] = await store.list_versions(USER, SLUG)
    assert (latest["version_no"], latest["based_on"]) == (3, 2)


@pytest.mark.asyncio
async def test_a_restored_version_stays_kept_until_a_save_prunes_it(agents_service, store, pool):
    cap = agents_service.agent_versions.MAX_VERSIONS
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    for n in range(2, cap + 1):
        await store.save(USER, SLUG, spec=_spec(), files=_files(f"Take {n}."))
    await store.save(USER, SLUG, spec=_spec(), files=_files(), restored_from=1)
    assert pool.kept() == list(range(1, cap + 1)) and await _current(store) == [1]

    await store.save(USER, SLUG, spec=_spec(), files=_files("Fresh."))
    assert pool.kept() == list(range(2, cap + 2))
    [latest, *_] = await store.list_versions(USER, SLUG)
    assert (latest["version_no"], latest["based_on"], latest["current"]) == (cap + 1, 1, True)


@pytest.mark.asyncio
async def test_a_version_reads_back_whole(store):
    await store.save(USER, SLUG, spec=_spec(), files=_files(**{"notes.md": "Ref."}), create_only=True)
    version = await store.get_version(USER, SLUG, 1)
    assert version["spec"] == _spec()
    assert version["files"] == _files(**{"notes.md": "Ref."})
    assert await store.get_version(USER, SLUG, 99) is None


@pytest.mark.asyncio
async def test_recreating_a_deleted_slug_starts_a_fresh_history(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."))
    assert await store.delete(USER, SLUG) is True
    assert pool.kept() == []

    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    assert await _history(store) == [(1, "created", [])]


# ---------------------------------------------------------------------------
# Purge and export
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_purge_takes_every_version_of_that_user_only(store, pool):
    await store.save(USER, SLUG, spec=_spec(), files=_files(), create_only=True)
    await store.save(USER, SLUG, spec=_spec(), files=_files("Changed."))
    await store.save("u2", SLUG, spec=_spec(), files=_files(), create_only=True)

    counts = await store.purge_user(USER)

    assert counts["agent_definition_versions"] == 2
    assert pool.kept() == [] and pool.kept("u2") == [1]


@pytest.mark.asyncio
async def test_export_pages_every_version_with_its_content(store):
    for slug in ("alpha", "beta"):
        await store.save(USER, slug, spec=_spec(slug=slug), files=_files(), create_only=True)
        await store.save(USER, slug, spec=_spec(slug=slug), files=_files("Changed."))

    seen, after = [], ("", 0)
    while page := await store.page_versions(USER, after, 3):
        seen += page
        after = (page[-1]["agent_slug"], page[-1]["version_no"])
    assert [(v["agent_slug"], v["version_no"]) for v in seen] == [
        ("alpha", 1), ("alpha", 2), ("beta", 1), ("beta", 2),
    ]
    # The export form: files as {path: {content, encoding}}, as stored.
    assert seen[1]["files"] == {"AGENT.md": {"content": "Changed.", "encoding": "utf-8"}}
    assert seen[1]["changes"] == ["instructions"]
    assert (seen[0]["based_on"], seen[1]["based_on"]) == (None, 1)
