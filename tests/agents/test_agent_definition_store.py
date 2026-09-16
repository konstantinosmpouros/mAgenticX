"""``AgentDefinitionStore`` — a custom agent's definition, with no folder behind it.

A user-authored agent used to be a directory: ``agent.yaml`` plus ``AGENT.md``
plus ``subagents/*.md``, mirrored into ``chat_db`` and reconciled every 900
seconds. It is now rows, and ``/reference/`` is a virtual route over the same
rows.

Two properties are worth pinning hard, because neither raises when it breaks:

* **the key mapping**, which decides whether the agent can see its own bundled
  files at all — a wrong key is an empty ``/reference/``, not an error; and
* **replace-never-merge**, because a save carries the whole definition, so a
  file the user deleted in the builder must not survive as a row the agent goes
  on reading.

Runs against a fake pool rather than a live Postgres — the same trade
``test_memory_store.py`` and ``test_skill_store.py`` make. The SQL itself is
exercised against real Postgres by the integration check in the same commit.
"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest
from langgraph.store.base import GetOp, ListNamespacesOp, PutOp, SearchOp

NOW = datetime(2026, 9, 17, 12, 0, tzinfo=UTC)
USER = "u1"
SLUG = "nova"


# ---------------------------------------------------------------------------
# A pool stand-in: replays canned rows in the order the store asks for them.
# ---------------------------------------------------------------------------
class _Cursor:
    def __init__(self, rows, rowcount=0):
        self._rows = rows
        self.rowcount = rowcount

    async def fetchone(self):
        return self._rows[0] if self._rows else None

    async def fetchall(self):
        return list(self._rows)


class _Transaction:
    """Stand-in for psycopg's transaction block.

    Present because the write that matters here is multi-statement — a save
    replaces every file — and it runs inside ``conn.transaction()``. A fake
    without it would pass only the read paths.
    """

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _Conn:
    def __init__(self, owner):
        self._owner = owner

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def transaction(self):
        return _Transaction()

    async def execute(self, sql, params=None):
        self._owner.calls.append((" ".join(sql.split()), params))
        rows = self._owner.next_rows.pop(0) if self._owner.next_rows else []
        return _Cursor(rows, rowcount=self._owner.rowcount)


class FakePool:
    def __init__(self, *row_batches, rowcount: int = 0):
        self.next_rows = list(row_batches)
        self.calls: list[tuple[str, object]] = []
        self.rowcount = rowcount

    def connection(self):
        return _Conn(self)


@pytest.fixture()
def Store(agents_service):
    """The store class from the freshly-imported service module.

    Reached through the fixture rather than imported at module scope: conftest
    purges and re-imports the service per test, so a module-level import would
    bind a stale twin.
    """
    return agents_service.definition_store.AgentDefinitionStore


def _file(path, content="body", encoding="utf-8"):
    return {"path": path, "content": content, "encoding": encoding}


# ---------------------------------------------------------------------------
# The spec column
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_spec_is_returned_as_a_dict(Store):
    pool = FakePool([{"spec": {"slug": SLUG, "prompt": "./AGENT.md"}, "updated_at": NOW}])
    row = await Store(pool).get_row(USER, SLUG)
    assert row["spec"]["prompt"] == "./AGENT.md"
    assert row["updated_at"] == NOW


@pytest.mark.asyncio
async def test_a_spec_that_arrives_as_json_text_is_decoded(Store):
    """psycopg decodes ``jsonb`` for us, but a driver configured otherwise hands
    back raw text — and a spec that silently reads as a string produces an agent
    that fails validation for no visible reason."""
    pool = FakePool([{"spec": '{"slug": "nova"}', "updated_at": NOW}])
    row = await Store(pool).get_row(USER, SLUG)
    assert row["spec"] == {"slug": "nova"}


@pytest.mark.asyncio
async def test_an_unparseable_spec_reads_as_empty_rather_than_raising(Store):
    # An empty spec fails AgentSpec validation, which the loader turns into
    # "no such agent" — a 404. Raising here would be a 500 instead.
    pool = FakePool([{"spec": "not json at all", "updated_at": NOW}])
    assert (await Store(pool).get_row(USER, SLUG))["spec"] == {}


@pytest.mark.asyncio
async def test_an_agent_the_user_does_not_have_reads_as_none(Store):
    assert await Store(FakePool([])).get_row(USER, "ghost") is None


# ---------------------------------------------------------------------------
# The key mapping — what `/reference/` exposes
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_keys_are_route_relative_absolute_paths(Store):
    """``StoreBackend.ls`` prefix-matches on the leading slash and reports the key
    verbatim as the file path, so a relative key is invisible to ``ls``/``glob``
    — the failure mode is bundled material the agent cannot discover, not an
    error."""
    pool = FakePool([_file("AGENT.md"), _file("subagents/worker.md")])
    files = await Store(pool)._files_for((USER, SLUG))
    assert sorted(files) == ["/AGENT.md", "/subagents/worker.md"]


@pytest.mark.asyncio
async def test_a_nested_path_keeps_its_folder_so_ls_can_synthesise_it(Store):
    # StoreBackend derives directories by splitting keys on "/" — flattening
    # would make `subagents/` vanish from the agent's `ls`.
    pool = FakePool([_file("subagents/worker.md")])
    assert "/subagents/worker.md" in await Store(pool)._files_for((USER, SLUG))


@pytest.mark.asyncio
async def test_an_incomplete_namespace_exposes_nothing(Store):
    # Defensive: a malformed namespace must read as empty, never as "every
    # file of every agent".
    pool = FakePool()
    assert await Store(pool)._files_for((USER,)) == {}
    assert pool.calls == []


@pytest.mark.asyncio
async def test_get_returns_the_file_with_its_encoding(Store):
    pool = FakePool([_file("AGENT.md", "You are Nova.")])
    [item] = await Store(pool).abatch(
        [GetOp(namespace=(USER, SLUG), key="/AGENT.md")]
    )
    assert item.value["content"] == "You are Nova."
    assert item.value["encoding"] == "utf-8"


@pytest.mark.asyncio
async def test_get_on_a_path_this_agent_does_not_have_is_a_miss(Store):
    pool = FakePool([_file("AGENT.md")])
    [item] = await Store(pool).abatch(
        [GetOp(namespace=(USER, SLUG), key="/somebody-elses.md")]
    )
    assert item is None


@pytest.mark.asyncio
async def test_search_lists_every_file_sorted(Store):
    pool = FakePool([_file("b.md"), _file("AGENT.md"), _file("subagents/w.md")])
    [items] = await Store(pool).abatch([SearchOp(namespace_prefix=(USER, SLUG))])
    assert [i.key for i in items] == ["/AGENT.md", "/b.md", "/subagents/w.md"]


@pytest.mark.asyncio
async def test_a_write_is_refused_rather_than_silently_applied(Store):
    """``/reference/`` is write-denied by the permission ladder, and deliberately
    so: a run that could rewrite its own definition could edit its next system
    prompt. A PutOp reaching the store means a rule was dropped upstream."""
    pool = FakePool()
    [result] = await Store(pool).abatch(
        [PutOp(namespace=(USER, SLUG), key="/AGENT.md", value={"content": "pwned"})]
    )
    assert result is None
    assert pool.calls == []            # nothing was written


@pytest.mark.asyncio
async def test_listing_namespaces_is_empty_rather_than_unsupported(Store):
    # deepagents probes this; raising would fail a tool call for no reason.
    [result] = await Store(FakePool()).abatch([ListNamespacesOp()])
    assert result == []


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_saving_replaces_the_files_rather_than_merging(Store):
    """A save carries the whole definition, so a file the user deleted in the
    builder must not survive as a row the agent goes on reading."""
    pool = FakePool([{"replaced": False}])
    await Store(pool).save(
        USER, SLUG, spec={"slug": SLUG}, files={"AGENT.md": ("x", "utf-8")}
    )
    statements = [sql for sql, _ in pool.calls]
    delete_at = next(i for i, s in enumerate(statements)
                     if s.startswith("DELETE FROM agent_definition_files"))
    insert_at = next(i for i, s in enumerate(statements)
                     if s.startswith("INSERT INTO agent_definition_files"))
    assert delete_at < insert_at


@pytest.mark.asyncio
async def test_a_save_reports_whether_it_replaced_an_existing_agent(Store):
    assert await Store(FakePool([{"replaced": True}])).save(
        USER, SLUG, spec={}, files={}
    ) is True
    assert await Store(FakePool([{"replaced": False}])).save(
        USER, SLUG, spec={}, files={}
    ) is False


@pytest.mark.asyncio
async def test_the_spec_and_its_files_land_in_one_transaction(Store):
    """Separately, there is a window where the spec's ``prompt:`` points at a
    file that has not been written — an agent that fails to build. The folder
    layout's staging-and-rename dance could not close it; a transaction does."""
    pool = FakePool([{"replaced": False}])
    await Store(pool).save(
        USER, SLUG, spec={"slug": SLUG, "prompt": "./AGENT.md"},
        files={"AGENT.md": ("x", "utf-8")},
    )
    statements = [sql for sql, _ in pool.calls]
    assert any(s.startswith("INSERT INTO agent_definitions") for s in statements)
    assert any(s.startswith("INSERT INTO agent_definition_files") for s in statements)


@pytest.mark.asyncio
async def test_deleting_removes_the_spec_and_its_files(Store):
    pool = FakePool(rowcount=1)
    assert await Store(pool).delete(USER, SLUG) is True
    statements = [sql for sql, _ in pool.calls]
    assert any("DELETE FROM agent_definitions" in s for s in statements)
    assert any("DELETE FROM agent_definition_files" in s for s in statements)


@pytest.mark.asyncio
async def test_deleting_an_agent_that_was_never_there_reports_nothing_removed(Store):
    assert await Store(FakePool(rowcount=0)).delete(USER, SLUG) is False
