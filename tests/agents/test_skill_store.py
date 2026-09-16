"""``SkillStore`` — the file API a skill mount reads, with no skill folders behind it.

The agent still sees ``/skills/<name>/SKILL.md`` and ``/default_skills/<name>/…``
exactly as it did when those were directories. Underneath, a custom skill is rows
in ``skill_files`` and a global one is a *pointer* into the catalogue on the
volume. Both resolve through this one store so the mount stays a plain
``StoreBackend`` and inherits its directory synthesis.

That makes the translation invisible from the outside, which is why it is pinned
here: a wrong answer does not raise, it just gives the agent a skill it should
not have, or silently drops one it should.

Runs against a fake pool rather than a live Postgres — the same trade
``test_memory_store.py`` makes. What needs pinning here is the **key mapping**,
the **namespace/tier dispatch** and the **custom-vs-global dispatch**; the SQL
itself is exercised against real Postgres by the integration check in the same
commit.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone

import pytest
from langgraph.store.base import GetOp, ListNamespacesOp, PutOp, SearchOp

# The store module is reached through the `agents_service` fixture, never
# imported at module scope: conftest purges and re-imports the service so each
# test gets settings it can repoint, and a module-level import would bind a
# stale twin whose `global_root` still points at the real volume.
POOL_TYPE_CUSTOM = "custom"
POOL_TYPE_GLOBAL = "global"
TIER_ASSIGNED = "assigned"
TIER_DECLARED = "declared"

NOW = datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)
USER = "u1"
AGENT = "omni"


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

    Present because the writes that matter here are the multi-statement ones —
    a create replaces every file, a removal cascades to three tables — and those
    run inside ``conn.transaction()``. A fake without it would pass only the
    single-statement paths.
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
def SkillStore(agents_service):
    """The store class from the freshly-imported service module."""
    return agents_service.skill_store.SkillStore


@pytest.fixture()
def catalogue_dir(agents_service):
    return agents_service.skill_store.catalogue_dir


def _pool_entry(name, type_=POOL_TYPE_CUSTOM, category="", description="d"):
    return {
        "skill_name": name,
        "type": type_,
        "category": category,
        "description": description,
        "origin": "user",
        "created_by_agent": None,
        "added_at": NOW,
    }


def _file(path, content="body", encoding="utf-8"):
    return {"path": path, "content": content, "encoding": encoding}


# ---------------------------------------------------------------------------
# Key mapping — the mount's whole contract
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_keys_are_route_relative_absolute_paths(SkillStore):
    """``StoreBackend.ls`` prefix-matches on the leading slash and reports the key
    verbatim as the file path, so a relative key is invisible to ``ls``/``glob``
    even though ``read_file`` on the exact path would still work — the failure
    mode is a skill the agent cannot discover, not an error."""
    pool = FakePool(
        [{"skill_name": "note-taker"}],                       # list_agent_skills
        [_pool_entry("note-taker")],                          # get_pool_entry
        [_file("SKILL.md"), _file("templates/plan.md")],      # skill_files
    )
    files = await SkillStore(pool)._files_for((USER, AGENT, TIER_ASSIGNED))

    assert sorted(files) == ["/note-taker/SKILL.md", "/note-taker/templates/plan.md"]


@pytest.mark.asyncio
async def test_a_nested_path_keeps_its_folder_so_ls_can_synthesise_the_directory(SkillStore):
    # StoreBackend derives directories by splitting keys on "/" — flattening a
    # nested file would make `references/` vanish from the agent's `ls`.
    pool = FakePool(
        [{"skill_name": "s"}],
        [_pool_entry("s")],
        [_file("references/api.md")],
    )
    files = await SkillStore(pool)._files_for((USER, AGENT, TIER_ASSIGNED))
    assert "/s/references/api.md" in files


# ---------------------------------------------------------------------------
# Tier dispatch — two mounts, one store
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_assigned_tier_reads_the_per_agent_assignment_rows(SkillStore):
    pool = FakePool([{"skill_name": "a"}, {"skill_name": "b"}])
    names = await SkillStore(pool)._names_for((USER, AGENT, TIER_ASSIGNED))
    assert names == ["a", "b"]
    assert "agent_skills" in pool.calls[0][0]


@pytest.mark.asyncio
async def test_declared_tier_takes_its_names_from_the_namespace_not_the_database(SkillStore):
    """A user-authored agent's tier ① is its spec's ``skills:`` list. The names
    ride in the namespace tail so this store never has to read an agent
    definition — the resolver knows the spec, the store knows the content."""
    pool = FakePool()
    names = await SkillStore(pool)._names_for((USER, AGENT, TIER_DECLARED, "x", "y"))
    assert names == ["x", "y"]
    assert pool.calls == []            # no query at all


@pytest.mark.asyncio
async def test_a_declared_namespace_with_no_names_exposes_nothing(SkillStore):
    # An empty tail must not fall through to the assigned list — that would show
    # a custom agent tier ② skills in its read-only tier ① mount.
    pool = FakePool()
    assert await SkillStore(pool)._names_for((USER, AGENT, TIER_DECLARED)) == []
    assert pool.calls == []


@pytest.mark.asyncio
async def test_blank_names_in_the_namespace_tail_are_dropped(SkillStore):
    pool = FakePool()
    names = await SkillStore(pool)._names_for((USER, AGENT, TIER_DECLARED, "x", "", "y"))
    assert names == ["x", "y"]


# ---------------------------------------------------------------------------
# Origin dispatch — the resolution model, per skill
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_custom_skill_reads_its_rows(SkillStore):
    pool = FakePool([_pool_entry("note-taker")], [_file("SKILL.md", "custom body")])
    files = await SkillStore(pool).read_files(USER, "note-taker")
    assert files == {"SKILL.md": ("custom body", "utf-8")}
    assert "skill_files" in pool.calls[-1][0]


@pytest.mark.asyncio
async def test_a_global_skill_reads_the_catalogue_and_never_queries_for_files(skills_fs, SkillStore):
    """A ``type='global'`` row is a *pointer*. Code that expects ``skill_files``
    rows for one finds none and silently serves an empty skill."""
    pool = FakePool([_pool_entry("deep-research", POOL_TYPE_GLOBAL, category="research")])
    files = await SkillStore(pool).read_files(USER, "deep-research")

    assert "SKILL.md" in files
    assert "Body for deep research." in files["SKILL.md"][0]
    assert len(pool.calls) == 1        # the pool lookup only — no file query


@pytest.mark.asyncio
async def test_a_skill_the_user_does_not_hold_reads_as_empty(SkillStore):
    # Not an error: an assignment can outlive a pool removal by one read.
    pool = FakePool([])
    assert await SkillStore(pool).read_files(USER, "gone") == {}


@pytest.mark.asyncio
async def test_a_catalogue_entry_that_vanished_between_image_builds_is_not_fatal(skills_fs, SkillStore):
    pool = FakePool([_pool_entry("removed-upstream", POOL_TYPE_GLOBAL, category="research")])
    assert await SkillStore(pool).read_files(USER, "removed-upstream") == {}


@pytest.mark.asyncio
async def test_a_binary_catalogue_asset_round_trips_as_base64(skills_fs, SkillStore, catalogue_dir):
    """A catalogue skill may ship a diagram beside SKILL.md. Decoding it as text
    would raise mid-run, so the encoding travels with the bytes."""
    folder = catalogue_dir("research", "deep-research")
    (folder / "diagram.png").write_bytes(b"\x89PNG\r\n\x1a\n\xff\xfe")

    pool = FakePool([_pool_entry("deep-research", POOL_TYPE_GLOBAL, category="research")])
    files = await SkillStore(pool).read_files(USER, "deep-research")

    content, encoding = files["diagram.png"]
    assert encoding == "base64"
    assert base64.b64decode(content).startswith(b"\x89PNG")


# ---------------------------------------------------------------------------
# The op surface StoreBackend actually drives
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_returns_the_file_with_its_encoding(SkillStore):
    pool = FakePool([{"skill_name": "s"}], [_pool_entry("s")], [_file("SKILL.md", "hello")])
    [item] = await SkillStore(pool).abatch(
        [GetOp(namespace=(USER, AGENT, TIER_ASSIGNED), key="/s/SKILL.md")]
    )
    assert item.value["content"] == "hello"
    assert item.value["encoding"] == "utf-8"


@pytest.mark.asyncio
async def test_get_on_a_path_the_namespace_does_not_expose_is_a_miss(SkillStore):
    pool = FakePool([{"skill_name": "s"}], [_pool_entry("s")], [_file("SKILL.md")])
    [item] = await SkillStore(pool).abatch(
        [GetOp(namespace=(USER, AGENT, TIER_ASSIGNED), key="/other/SKILL.md")]
    )
    assert item is None


@pytest.mark.asyncio
async def test_search_lists_every_file_sorted(SkillStore):
    pool = FakePool(
        [{"skill_name": "s"}],
        [_pool_entry("s")],
        [_file("b.md"), _file("SKILL.md"), _file("a/c.md")],
    )
    [items] = await SkillStore(pool).abatch(
        [SearchOp(namespace_prefix=(USER, AGENT, TIER_ASSIGNED))]
    )
    assert [i.key for i in items] == ["/s/SKILL.md", "/s/a/c.md", "/s/b.md"]


@pytest.mark.asyncio
async def test_a_write_is_refused_rather_than_silently_applied(SkillStore):
    """``/skills/`` is write-denied by the permission ladder, so a PutOp reaching
    the store means a rule was dropped upstream. Ignoring it keeps a skill from
    being rewritten by the agent that reads it; the log line is the signal."""
    pool = FakePool()
    [result] = await SkillStore(pool).abatch(
        [PutOp(namespace=(USER, AGENT, TIER_ASSIGNED), key="/s/SKILL.md", value={"content": "x"})]
    )
    assert result is None
    assert pool.calls == []            # nothing was written


@pytest.mark.asyncio
async def test_listing_namespaces_is_empty_rather_than_unsupported(SkillStore):
    # deepagents probes this; raising would fail a tool call for no reason.
    [result] = await SkillStore(FakePool()).abatch([ListNamespacesOp()])
    assert result == []


# ---------------------------------------------------------------------------
# Pool writes
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_saving_a_custom_skill_replaces_its_files_rather_than_merging(SkillStore):
    """A save carries the whole folder, so a file the user deleted must not
    survive as a leftover row the agent goes on reading."""
    pool = FakePool()
    await SkillStore(pool).add_custom(
        USER, "s", files={"SKILL.md": ("x", "utf-8")}, description="d"
    )
    statements = [sql for sql, _ in pool.calls]
    assert any(s.startswith("DELETE FROM skill_files") for s in statements)
    assert statements.index(next(s for s in statements if s.startswith("DELETE FROM skill_files"))) < \
        statements.index(next(s for s in statements if s.startswith("INSERT INTO skill_files")))


@pytest.mark.asyncio
async def test_removing_a_skill_cascades_to_every_agent_that_had_it(SkillStore):
    """An assignment to a skill the user no longer holds would mount a folder
    with nothing behind it — a skill directory the agent sees and cannot read."""
    pool = FakePool(rowcount=1)
    assert await SkillStore(pool).remove(USER, "s") is True
    statements = [sql for sql, _ in pool.calls]
    assert any("DELETE FROM agent_skills" in s for s in statements)
    assert any("DELETE FROM skill_files" in s for s in statements)


@pytest.mark.asyncio
async def test_a_removal_tombstones_rather_than_deleting_the_pool_row(SkillStore):
    # A hard delete lets a name the user removed come back from a stale read.
    pool = FakePool(rowcount=1)
    await SkillStore(pool).remove(USER, "s")
    assert any("UPDATE skill_pool SET deleted_at" in sql for sql, _ in pool.calls)


@pytest.mark.asyncio
async def test_removing_a_skill_the_user_never_held_reports_nothing_removed(SkillStore):
    pool = FakePool(rowcount=0)
    assert await SkillStore(pool).remove(USER, "s") is False
