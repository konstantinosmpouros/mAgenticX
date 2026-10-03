"""The store side of remote skills (plan 30): the pointer, the mount, the search.

A remote pool entry is a *pointer* into a shared, immutable copy — like a legacy
global entry, it carries no ``skill_files`` rows of its own. What must hold:

* it reads from ``remote_skill_files`` at **the content ref it pinned**, so a
  later upstream change can never reach a user who did not re-add the skill;
* it mounts under ``/skills/<name>/`` exactly like any other entry;
* an Add of a copy that already exists is one row and no file writes;
* the search keeps free text out of the SQL entirely.

Runs against a scripted pool, the same trade ``test_skill_store.py`` makes; the
SQL itself was run against real Postgres when this landed (plan 30, §2.2).
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from langgraph.store.base import GetOp

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


class _Cursor:
    def __init__(self, rows):
        self._rows = rows
        self.rowcount = 0

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
        return _Cursor(rows)


class FakePool:
    """Replays canned rows in the order the store asks for them."""

    def __init__(self, *row_batches):
        self.next_rows = list(row_batches)
        self.calls: list[tuple[str, object]] = []

    def connection(self):
        return _Conn(self)


def _remote_entry(name="cudf", source_id="nvidia", ref="ref-1", commit="c" * 40):
    return {
        "skill_name": name, "type": "remote", "category": "", "description": "d",
        "origin": "user", "created_by_agent": None, "added_at": NOW,
        "source_id": source_id, "source_ref": ref, "source_commit": commit, "licence": "MIT",
    }


@pytest.fixture()
def store_mod(agents_service):
    return agents_service.skill_store


@pytest.mark.asyncio
async def test_a_remote_entry_reads_the_copy_it_pinned(store_mod):
    pool = FakePool(
        [_remote_entry(ref="ref-1")],
        [{"path": "SKILL.md", "content": "body", "encoding": "utf-8"},
         {"path": "logo.png", "content": "iVBO", "encoding": "base64"}],
    )
    files = await store_mod.SkillStore(pool).read_files("u1", "cudf")

    assert files == {"SKILL.md": ("body", "utf-8"), "logo.png": ("iVBO", "base64")}
    sql, params = pool.calls[-1]
    assert "FROM remote_skill_files" in sql
    # Pinned: the content ref from the pool row, not whatever the catalogue
    # says today.
    assert params == ("nvidia", "cudf", "ref-1")
    assert not any("FROM skill_files" in call[0] for call in pool.calls)


@pytest.mark.asyncio
async def test_a_remote_skill_mounts_like_any_other(store_mod):
    """The agent sees ``/skills/<name>/SKILL.md`` whatever kind of entry it is."""
    pool = FakePool(
        [{"skill_name": "cudf"}],                                 # list_agent_skills
        [_remote_entry()],                                         # get_pool_entry
        [{"path": "SKILL.md", "content": "body", "encoding": "utf-8"}],
    )
    store = store_mod.SkillStore(pool)
    [item] = await store.abatch([GetOp(namespace=("u1", "omni", store_mod.TIER_ASSIGNED), key="/cudf/SKILL.md")])
    assert item is not None and item.value["content"] == "body"


@pytest.mark.asyncio
async def test_adding_an_existing_copy_writes_one_row_and_no_files(store_mod):
    pool = FakePool()
    await store_mod.SkillStore(pool).add_remote(
        "u1", "cudf", source_id="nvidia", content_ref="ref-1", source_commit="c" * 40,
        licence="MIT", files=None,
    )
    assert len(pool.calls) == 1
    sql, params = pool.calls[0]
    assert sql.startswith("INSERT INTO skill_pool")
    assert params[2] == store_mod.POOL_TYPE_REMOTE
    assert "remote_skill_files" not in sql


def test_query_terms_are_reduced_to_safe_tsquery_fragments(store_mod):
    terms = store_mod.catalogue_query_terms
    assert terms("React Performance") == ["react", "performance"]
    # Operators, quotes and backslashes cannot survive into a tsquery.
    assert terms("a & b | !c 'drop' \\x:*") == ["drop"]
    assert terms("x") == []                                    # under two characters
    assert terms("dup dup DUP") == ["dup"]
    assert len(terms(" ".join(f"t{i}x" for i in range(20)))) == 8
    assert terms("y" * 33) == []                               # over 32 characters


@pytest.mark.asyncio
async def test_search_keeps_the_query_out_of_the_sql_text(store_mod):
    pool = FakePool([])
    await store_mod.SkillStore(pool).search_catalogue(
        ["react", "perf"], source_ids=["ecc"], limit=500, offset=-3
    )
    sql, params = pool.calls[0]
    assert "react" not in sql and "perf" not in sql
    assert params["tsq"] == "react:* | perf:*"
    assert params["sources"] == ["ecc"]
    assert params["limit"] == store_mod.MAX_SEARCH_LIMIT        # clamped
    assert params["offset"] == 0
    assert "c.refusal IS NULL" in sql and "c.withdrawn_at IS NULL" in sql


@pytest.mark.asyncio
async def test_an_empty_query_is_an_alphabetical_browse(store_mod):
    pool = FakePool([])
    rows, total = await store_mod.SkillStore(pool).search_catalogue([], source_ids=["ecc"])
    assert (rows, total) == ([], 0)
    sql, params = pool.calls[0]
    assert "to_tsquery" not in sql and "ORDER BY c.skill_id" in sql
