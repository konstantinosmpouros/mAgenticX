"""``AgentMemoryStore`` — the file API with no filesystem behind it.

The agent reads `/memories/AGENTS.md` and `/memories/entries/<name>.yml` exactly
as before; underneath, both are rows. These pin the translation, because a wrong
answer here is invisible from the outside: the agent would simply see memory it
does not have, or lose memory it does.

Runs against a fake pool rather than a live Postgres — the SQL is exercised by
the integration check in the same commit; what needs pinning here is the op
dispatch, the derived index, and the key mapping.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
import yaml
from langgraph.store.base import GetOp, ListNamespacesOp, PutOp, SearchOp

from harness.memory.store import (
    INDEX_KEY,
    AgentMemoryStore,
    build_index,
    entry_key,
    entry_name,
    render_entry,
)

NOW = datetime(2026, 9, 8, 12, 0, tzinfo=timezone.utc)
NS = ("u1", "omni")


# ---------------------------------------------------------------------------
# A pool stand-in: records SQL, replays canned rows.
# ---------------------------------------------------------------------------
class _Cursor:
    def __init__(self, rows, rowcount=0):
        self._rows = rows
        self.rowcount = rowcount

    async def fetchone(self):
        return self._rows[0] if self._rows else None

    async def fetchall(self):
        return list(self._rows)


class _Conn:
    def __init__(self, owner):
        self._owner = owner

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def execute(self, sql, params=None):
        self._owner.calls.append((" ".join(sql.split()), params))
        return _Cursor(self._owner.next_rows.pop(0) if self._owner.next_rows else [],
                       rowcount=self._owner.rowcount)


class FakePool:
    def __init__(self, *row_batches, rowcount: int = 0):
        self.next_rows = list(row_batches)
        self.calls: list[tuple[str, object]] = []
        self.rowcount = rowcount

    def connection(self):
        return _Conn(self)


def _row(name, summary="s", content="c", raw=None):
    return {
        "name": name,
        "summary": summary,
        "content": content,
        "raw": raw if raw is not None else render_entry(
            {"name": name, "summary": summary, "content": content}
        ),
        "source_conversation_id": None,
        "source_run_id": None,
        "source_thread_id": None,
        "created_by": "agent",
        "trust_level": "unknown",
        "created_at": NOW,
        "updated_at": NOW,
    }


# ---------------------------------------------------------------------------
# Key mapping
# ---------------------------------------------------------------------------
def test_entry_keys_round_trip():
    # Absolute: StoreBackend.ls() prefix-matches on the leading slash and
    # reports item.key verbatim, so a relative key hides the file from `ls`.
    assert entry_key("user-timezone") == "/entries/user-timezone.yml"
    assert entry_name("/entries/user-timezone.yml") == "user-timezone"


def test_a_relative_key_is_normalised_rather_than_rejected():
    assert entry_name("entries/user-timezone.yml") == "user-timezone"


@pytest.mark.parametrize("key", ["/AGENTS.md", "/entries/", "/notes.txt", "/entries/x.txt"])
def test_non_entry_keys_are_not_mistaken_for_entries(key):
    # A path under /memories/ that is not an entry must not be given a row.
    assert entry_name(key) is None


# ---------------------------------------------------------------------------
# The derived index
# ---------------------------------------------------------------------------
def test_the_index_carries_the_template_and_one_line_per_row():
    text = build_index([_row("user-timezone", summary="Lives in Athens"),
                        _row("project-x", summary="Ships in Q4")])
    assert "# Agent Memory" in text            # the prose the model reads
    assert "## Memories" in text
    assert "- **user-timezone** — Lives in Athens" in text
    assert "- **project-x** — Ships in Q4" in text


def test_an_empty_pair_still_gets_a_usable_index():
    # The agent is told it has a memory index; handing it nothing would read as
    # a broken mount rather than an empty one.
    text = build_index([])
    assert "## Memories" in text and "# Agent Memory" in text


@pytest.mark.asyncio
async def test_getting_the_index_synthesises_it_from_rows():
    store = AgentMemoryStore(FakePool([_row("a", summary="first")]))
    item = (await store.abatch([GetOp(NS, INDEX_KEY, False)]))[0]
    assert item is not None
    assert "- **a** — first" in item.value["content"]
    assert item.value["encoding"] == "utf-8"


@pytest.mark.asyncio
async def test_writing_the_index_is_a_no_op():
    # It is derived, so honouring a write would let the index drift from the
    # entries it indexes — and would let an agent edit its own index directly.
    pool = FakePool()
    store = AgentMemoryStore(pool)
    await store.abatch([PutOp(NS, INDEX_KEY, {"content": "hand-written", "encoding": "utf-8"})])
    assert pool.calls == []


# ---------------------------------------------------------------------------
# Entries through the file API
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_getting_an_entry_returns_the_stored_bytes_verbatim():
    raw = "name: a\nsummary: kept exactly\ncontent: body\n"
    store = AgentMemoryStore(FakePool([{"raw": raw, "created_at": NOW, "updated_at": NOW}]))
    item = (await store.abatch([GetOp(NS, entry_key("a"), False)]))[0]
    assert item.value["content"] == raw


@pytest.mark.asyncio
async def test_a_missing_entry_returns_none_not_an_error():
    store = AgentMemoryStore(FakePool([]))
    assert (await store.abatch([GetOp(NS, entry_key("nope"), False)]))[0] is None


@pytest.mark.asyncio
async def test_writing_an_entry_through_the_file_api_projects_its_fields():
    # The mount is read-write, so an agent can bypass the `remember` tool. The
    # bytes are kept verbatim and the columns are filled best-effort.
    raw = yaml.safe_dump({"name": "a", "summary": "projected", "content": "body"})
    pool = FakePool([], [], rowcount=1)
    store = AgentMemoryStore(pool)
    await store.abatch([PutOp(NS, entry_key("a"), {"content": raw, "encoding": "utf-8"})])
    insert = [c for c in pool.calls if "INSERT INTO agent_memories" in c[0]]
    assert len(insert) == 1
    assert "projected" in insert[0][1]


@pytest.mark.asyncio
async def test_unparseable_content_is_still_stored():
    # The agent's read path must not depend on us understanding what it wrote.
    pool = FakePool([], [], rowcount=1)
    store = AgentMemoryStore(pool)
    await store.abatch([PutOp(NS, entry_key("a"), {"content": ": not yaml :", "encoding": "utf-8"})])
    insert = [c for c in pool.calls if "INSERT INTO agent_memories" in c[0]]
    assert len(insert) == 1 and ": not yaml :" in insert[0][1]


@pytest.mark.asyncio
async def test_a_null_value_deletes_the_row():
    pool = FakePool(rowcount=1)
    store = AgentMemoryStore(pool)
    await store.abatch([PutOp(NS, entry_key("a"), None)])
    assert any("DELETE FROM agent_memories" in c[0] for c in pool.calls)


@pytest.mark.asyncio
async def test_an_unsupported_path_is_refused_not_invented():
    pool = FakePool()
    store = AgentMemoryStore(pool)
    await store.abatch([PutOp(NS, "notes.txt", {"content": "x", "encoding": "utf-8"})])
    assert pool.calls == []


# ---------------------------------------------------------------------------
# ls / glob / grep go through search
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_search_lists_the_entries_and_the_index():
    # Omitting the index would make AGENTS.md invisible to the very tools the
    # agent uses to discover its own memory.
    store = AgentMemoryStore(FakePool([_row("a"), _row("b")], [_row("a"), _row("b")]))
    items = (await store.abatch([SearchOp(NS)]))[0]
    keys = [i.key for i in items]
    assert keys[0] == INDEX_KEY
    assert entry_key("a") in keys and entry_key("b") in keys


# ---------------------------------------------------------------------------
# Namespacing and the sync stance
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_namespaces_are_user_and_agent_pairs():
    store = AgentMemoryStore(FakePool([{"user_id": "u1", "agent_slug": "omni"}]))
    assert (await store.abatch([ListNamespacesOp(())]))[0] == [("u1", "omni")]


@pytest.mark.asyncio
async def test_a_short_namespace_is_rejected():
    # Memory is per-(user, agent) so one agent's memory never reaches another's
    # context. A one-element namespace would silently widen that scope.
    store = AgentMemoryStore(FakePool())
    with pytest.raises(ValueError):
        await store.abatch([GetOp(("u1",), INDEX_KEY, False)])


def test_calling_batch_on_the_loop_thread_is_refused():
    # `batch` exists for deepagents' synchronous ls()/glob()/grep(), which the
    # protocol layer runs via asyncio.to_thread. Bridging from the loop thread
    # itself would deadlock, so it is refused rather than hung.
    async def _on_loop():
        store = AgentMemoryStore(FakePool())
        with pytest.raises(RuntimeError, match="event loop thread"):
            store.batch([])

    import asyncio as _a
    _a.get_event_loop_policy().new_event_loop().run_until_complete(_on_loop())


def test_batch_without_a_loop_is_refused():
    store = AgentMemoryStore(FakePool())
    with pytest.raises(RuntimeError, match="none is running"):
        store.batch([])


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def test_rendering_omits_provenance():
    # Provenance is the audit trail. On disk-shaped bytes the agent can read and
    # write, it would be something the agent could rewrite about itself.
    text = render_entry({"name": "a", "summary": "s", "content": "c",
                         "source_conversation_id": "conv-1"})
    data = yaml.safe_load(text)
    assert set(data) == {
        "name", "summary", "content", "created_at", "updated_at",
        "source_conversation_id",
    }
    assert "trust_level" not in data and "source_run_id" not in data


def test_rendering_is_stable_for_identical_input():
    # An unstable render would make every re-save look like a content change.
    record = {"name": "a", "summary": "s", "content": "c", "created_at": "t", "updated_at": "t"}
    assert render_entry(record) == render_entry(dict(record))
