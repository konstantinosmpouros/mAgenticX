"""The ``forget`` tool — the agent-facing delete for its own memory.

It runs *inside* a live agent turn, which sets the bar for its failure
behaviour: raising would fail the user's run, so every path returns a string the
model can read and react to.

The delete is final. There is no tombstone and no second copy — the row is the
only home a memory has — so the user cannot undo it from the memory panel
either. That is why it ships approval-gated by default, and why the "already
gone" case is reported as success rather than as an error: the agent asked for
an end state that already holds.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def forget(agents_service):
    return importlib.import_module("harness.tools.forget")


class FakeStore:
    """Records the delete it was asked for; fails or misses on demand."""

    def __init__(self, *, removed=True, explode=False):
        self._removed = removed
        self._explode = explode
        self.deletes: list[tuple[str, str, str]] = []

    async def delete_entry(self, user_id, agent_slug, name):
        if self._explode:
            raise RuntimeError("postgres is having a moment")
        self.deletes.append((user_id, agent_slug, name))
        return self._removed


@pytest.fixture
def bind(forget, monkeypatch):
    """Build the tool against a FakeStore and hand back both."""

    def _bind(**store_kwargs):
        store = FakeStore(**store_kwargs)
        monkeypatch.setattr(forget, "get_memory_pool", lambda: object())
        monkeypatch.setattr(forget, "AgentMemoryStore", lambda _pool: store)
        tool = forget.build_forget_tool(user_id="u1", agent_slug="omni")
        return tool, store

    return _bind


# ---------------------------------------------------------------------------
# Deleting
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_it_deletes_the_named_memory(bind):
    tool, store = bind()
    out = await tool.ainvoke({"name": "user-timezone"})

    assert store.deletes == [("u1", "omni", "user-timezone")]
    assert "user-timezone" in out


@pytest.mark.asyncio
async def test_the_pair_is_bound_at_build_time(bind):
    # The tool closes over this run's (user, agent); nothing in the arguments
    # can redirect it at another pair's memory.
    tool, store = bind()
    await tool.ainvoke({"name": "anything"})

    user_id, agent_slug, _ = store.deletes[0]
    assert (user_id, agent_slug) == ("u1", "omni")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "given, expected",
    [
        ("User Timezone", "user-timezone"),
        ("  project::magenticx  ", "project-magenticx"),
        ("Already-Slugged", "already-slugged"),
    ],
)
async def test_the_name_is_slugified_the_same_way_remember_slugs_it(bind, given, expected):
    # Both tools must agree on what the key is, or the agent deletes a memory it
    # did not mean — or misses the one it did.
    tool, store = bind()
    await tool.ainvoke({"name": given})
    assert store.deletes[0][2] == expected


@pytest.mark.asyncio
async def test_remember_and_forget_agree_on_the_slug(agents_service):
    memory = importlib.import_module("harness.memory")
    assert memory.slugify_name("User Timezone") == "user-timezone"


# ---------------------------------------------------------------------------
# Nothing here raises
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_forgetting_something_that_is_gone_is_reported_plainly(bind):
    # Idempotent: a node re-entered after an approval pause runs this again.
    tool, store = bind(removed=False)
    out = await tool.ainvoke({"name": "never-existed"})

    assert "nothing to forget" in out.lower()
    assert store.deletes  # it still asked; "gone" is the store's answer


@pytest.mark.asyncio
async def test_a_store_failure_returns_a_message_instead_of_raising(bind):
    tool, _ = bind(explode=True)
    out = await tool.ainvoke({"name": "user-timezone"})
    assert "could not delete" in out.lower()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["", "   ", "!!!", "---"])
async def test_a_name_with_nothing_to_slug_is_refused_before_any_delete(bind, name):
    # A name that slugs to nothing would otherwise become a delete for "".
    tool, store = bind()
    out = await tool.ainvoke({"name": name})

    assert "must contain letters or digits" in out
    assert store.deletes == []


# ---------------------------------------------------------------------------
# How it is offered
# ---------------------------------------------------------------------------
def test_it_is_registered_as_an_approval_gated_builtin(agents_service):
    builtins_mod = importlib.import_module("harness.tools.builtins")
    registry = importlib.import_module("harness.tools.registry")

    assert "forget" in registry.NATIVE_TOOLS
    # Gated by default: the user has no way to undo it afterwards.
    assert builtins_mod.BUILTIN_BY_NAME["forget"].hitl_default is True
    assert "forget" in builtins_mod.builtin_hitl_defaults()
    # Not locked — the user may still switch the approval off for themselves.
    assert builtins_mod.BUILTIN_BY_NAME["forget"].locked is False


def test_it_follows_the_memory_toggle(agents_service):
    # No point offering a delete for a memory this run does not have mounted.
    registry = importlib.import_module("harness.tools.registry")
    ctx = registry.NativeToolContext(
        user_id="u1", agent_slug="omni", conversation_id="c1", use_memory=False
    )
    assert registry.NATIVE_TOOLS["forget"].builder(ctx) is None

    ctx_on = registry.NativeToolContext(
        user_id="u1", agent_slug="omni", conversation_id="c1", use_memory=True
    )
    assert registry.NATIVE_TOOLS["forget"].builder(ctx_on) is not None
