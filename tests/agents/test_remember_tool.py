"""The ``remember`` tool — the only writer of agent memory.

It runs *inside* a live agent turn, which sets the bar for its failure
behaviour: raising would fail the user's run, and a memory the agent believes it
saved but did not is worse than a refusal it can read and react to. Every path
here therefore returns a string.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def remember(agents_service):
    return importlib.import_module("harness.tools.remember")


class FakeStore:
    """Records what the tool asked for; fails on demand."""

    def __init__(self, *, existing=None, count=0, explode=False):
        self._existing = existing
        self._count = count
        self._explode = explode
        self.upserts: list[dict] = []

    async def read_entry(self, user_id, agent_slug, name):
        return self._existing

    async def count_pair(self, user_id, agent_slug):
        return self._count

    async def upsert(self, **kwargs):
        if self._explode:
            raise RuntimeError("postgres is having a moment")
        self.upserts.append(kwargs)
        return {"name": kwargs["name"]}


@pytest.fixture
def bind(remember, monkeypatch):
    """Build the tool against a FakeStore and hand back both."""

    def _bind(**store_kwargs):
        store = FakeStore(**store_kwargs)
        monkeypatch.setattr(remember, "get_memory_pool", lambda: object())
        monkeypatch.setattr(remember, "AgentMemoryStore", lambda _pool: store)
        tool = remember.build_remember_tool(
            user_id="u1",
            agent_slug="omni",
            conversation_id="conv-1",
            run_id="run-9",
            thread_id="thr-2",
            trust_level="untrusted",
        )
        return tool, store

    return _bind


# ---------------------------------------------------------------------------
# Shape
# ---------------------------------------------------------------------------
def test_the_tool_is_a_coroutine(bind):
    # Writing a memory is a database round trip now; a sync tool would block a
    # worker thread for it.
    tool, _ = bind()
    assert tool.coroutine is not None
    assert tool.name == "remember"


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_messy_name_becomes_a_safe_slug(bind):
    # The slug is the key the agent later addresses as entries/<slug>.yml, so it
    # must not carry slashes or dots into a path the model will try to read.
    tool, store = bind()
    out = await tool.ainvoke({"name": "User Timezone!! ", "summary": "s", "content": "c"})
    assert store.upserts[0]["name"] == "user-timezone"
    assert "user-timezone" in out


@pytest.mark.asyncio
async def test_a_name_with_no_usable_characters_is_refused(bind):
    tool, store = bind()
    out = await tool.ainvoke({"name": "!!!", "summary": "s", "content": "c"})
    assert store.upserts == []
    assert "must contain letters or digits" in out


@pytest.mark.parametrize("field", ["summary", "content"])
@pytest.mark.asyncio
async def test_both_body_fields_are_required(bind, field):
    tool, store = bind()
    args = {"name": "a", "summary": "s", "content": "c"}
    args[field] = "   "
    out = await tool.ainvoke(args)
    assert store.upserts == []
    assert "required" in out


@pytest.mark.asyncio
async def test_oversized_fields_are_truncated_not_rejected(bind, remember):
    # The summary becomes an always-on index line, so an unbounded one would
    # grow every future prompt. Truncating keeps the save rather than losing it.
    tool, store = bind()
    await tool.ainvoke({"name": "a", "summary": "x" * 500, "content": "y" * 20000})
    saved = store.upserts[0]
    assert len(saved["summary"]) == remember._MAX_SUMMARY
    assert len(saved["content"]) == remember._MAX_CONTENT


# ---------------------------------------------------------------------------
# The cap
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_new_entry_is_refused_once_the_cap_is_reached(bind, agents_service):
    cap = agents_service.settings_module.settings.filesystem.memory_max_entries
    tool, store = bind(existing=None, count=cap)
    out = await tool.ainvoke({"name": "a", "summary": "s", "content": "c"})
    assert store.upserts == []
    assert "Memory is full" in out


@pytest.mark.asyncio
async def test_an_update_still_goes_through_at_the_cap(bind, agents_service):
    # Otherwise a full memory could never be corrected — only added to, which is
    # exactly the thing the cap forbids.
    cap = agents_service.settings_module.settings.filesystem.memory_max_entries
    tool, store = bind(existing={"name": "a"}, count=cap)
    out = await tool.ainvoke({"name": "a", "summary": "s", "content": "c"})
    assert len(store.upserts) == 1
    assert "Saved memory" in out


# ---------------------------------------------------------------------------
# Provenance
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_the_run_identity_is_recorded(bind):
    # A durable memory is future context, so an entry written by a run that
    # could reach external content has to stay identifiable afterwards.
    tool, store = bind()
    await tool.ainvoke({"name": "a", "summary": "s", "content": "c"})
    saved = store.upserts[0]
    assert saved["source_conversation_id"] == "conv-1"
    assert saved["source_run_id"] == "run-9"
    assert saved["source_thread_id"] == "thr-2"
    assert saved["trust_level"] == "untrusted"
    assert saved["created_by"] == "agent"


# ---------------------------------------------------------------------------
# Failure
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_store_failure_is_reported_not_raised(bind):
    # The agent is mid-thought. An exception here fails the whole run; a string
    # is something it can reason about and retry or mention.
    tool, _ = bind(explode=True)
    out = await tool.ainvoke({"name": "a", "summary": "s", "content": "c"})
    assert out == "Could not save the memory right now."
