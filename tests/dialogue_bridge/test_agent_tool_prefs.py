"""Per-(user, agent) tool choices live in chat_db.

Two axes on one row, because a tool can be switched on *and* gated. Three
subtleties are worth pinning, all of them invisible from the screen until wrong:

1. **One UI boolean means two opposite things on the enable axis.** For a tool
   the agent *declares* (on by default), "off" is a stored row and "on" is the
   absence of one; for an undeclared gateway tool it is mirrored. Backwards, and
   the table fills with rows meaning "normal" — or a toggle looks inert.
2. **Approval is tri-state.** Prebuilt tools default to gated, so "the user
   turned this off" has to be storable. ``NULL`` follows the baseline, ``True``
   gates, ``False`` clears. A plain boolean collapsed the last two.
3. **Enablement is MCP-only.** A prebuilt tool is built downstream of the tool
   list we hand the framework, so no stored row could filter one.
"""

import pytest
import pytest_asyncio

from utils import agent_tool_prefs as prefs


@pytest_asyncio.fixture
async def db(session_factory):
    """A real session — these choices are rows, not a proxied call."""
    async with session_factory() as session:
        yield session


@pytest.fixture
def rows():
    """A baseline as the agents service reports it: one gated builtin, two MCP."""
    return [
        {"key": "write_file", "name": "write_file", "kind": "builtin", "group": "Filesystem",
         "declared": True, "enabled": True, "approval": True, "approvalLocked": False},
        {"key": "execute", "name": "execute", "kind": "builtin", "group": "Execution",
         "declared": True, "enabled": True, "approval": True, "approvalLocked": True},
        {"key": "rag/sql_query", "name": "sql_query", "kind": "mcp", "group": "rag",
         "declared": True, "enabled": True, "approval": False, "approvalLocked": False},
        {"key": "arxiv/download_paper", "name": "download_paper", "kind": "mcp", "group": "arxiv",
         "declared": False, "enabled": False, "approval": False, "approvalLocked": False},
    ]


def _by_key(applied, field):
    return {r["key"]: r[field] for r in applied}


async def _apply(db, rows, user="u1", agent="omni"):
    disabled, enabled, approvals = await prefs.read_prefs(db, user, agent)
    return prefs.apply_to_rows(rows, disabled, enabled, approvals)


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_pair_with_no_choices_reads_empty(db):
    # Not an error state — it means "the agent's baseline", which is exactly
    # what the caller should apply.
    assert await prefs.read_prefs(db, "u1", "omni") == (set(), set(), {})


@pytest.mark.asyncio
async def test_the_run_config_is_sorted_and_complete(db):
    await prefs.set_enabled(db, "u1", "omni", "rag/sql_query", enabled=False, declared=True)
    await prefs.set_approval(db, "u1", "omni", "write_file", required=False, baseline=True)
    await db.commit()

    assert await prefs.read_config(db, "u1", "omni") == {
        "enabled": [],
        "disabled": ["rag/sql_query"],
        "approvals": {"write_file": False},
    }


@pytest.mark.asyncio
async def test_choices_do_not_leak_across_agents_or_users(db):
    # The pairing is the unit.
    await prefs.set_enabled(db, "u1", "omni", "rag/sql_query", enabled=False, declared=True)
    await prefs.set_approval(db, "u1", "omni", "write_file", required=False, baseline=True)
    await db.commit()

    assert await prefs.read_prefs(db, "u1", "other-agent") == (set(), set(), {})
    assert await prefs.read_prefs(db, "u2", "omni") == (set(), set(), {})


# ---------------------------------------------------------------------------
# Enable: what a toggle means depends on the tool's default
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_turning_a_declared_tool_off_stores_an_override(db):
    await prefs.set_enabled(db, "u1", "omni", "rag/sql_query", enabled=False, declared=True)
    await db.commit()
    assert (await prefs.read_prefs(db, "u1", "omni"))[0] == {"rag/sql_query"}


@pytest.mark.asyncio
async def test_turning_a_declared_tool_back_on_clears_it(db):
    # Back-to-default is a deleted row, not a stored opposite.
    await prefs.set_enabled(db, "u1", "omni", "rag/sql_query", enabled=False, declared=True)
    await prefs.set_enabled(db, "u1", "omni", "rag/sql_query", enabled=True, declared=True)
    await db.commit()
    assert await prefs.read_prefs(db, "u1", "omni") == (set(), set(), {})


@pytest.mark.asyncio
async def test_turning_an_undeclared_tool_on_stores_an_override(db):
    await prefs.set_enabled(db, "u1", "omni", "arxiv/download_paper", enabled=True, declared=False)
    await db.commit()
    assert (await prefs.read_prefs(db, "u1", "omni"))[1] == {"arxiv/download_paper"}


@pytest.mark.asyncio
async def test_turning_an_undeclared_tool_off_clears_it(db):
    await prefs.set_enabled(db, "u1", "omni", "arxiv/download_paper", enabled=True, declared=False)
    await prefs.set_enabled(db, "u1", "omni", "arxiv/download_paper", enabled=False, declared=False)
    await db.commit()
    assert await prefs.read_prefs(db, "u1", "omni") == (set(), set(), {})


# ---------------------------------------------------------------------------
# Approval: tri-state
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_clearing_a_default_gate_is_stored_as_a_real_choice(db):
    # The reason the column is nullable. `write_file` is gated by the baseline,
    # so "off" cannot be spelled as a missing row.
    await prefs.set_approval(db, "u1", "omni", "write_file", required=False, baseline=True)
    await db.commit()
    assert (await prefs.read_prefs(db, "u1", "omni"))[2] == {"write_file": False}


@pytest.mark.asyncio
async def test_gating_an_ungated_tool_is_stored(db):
    await prefs.set_approval(db, "u1", "omni", "rag/sql_query", required=True, baseline=False)
    await db.commit()
    assert (await prefs.read_prefs(db, "u1", "omni"))[2] == {"rag/sql_query": True}


@pytest.mark.asyncio
async def test_a_choice_matching_the_baseline_stores_nothing(db):
    await prefs.set_approval(db, "u1", "omni", "write_file", required=True, baseline=True)
    await prefs.set_approval(db, "u1", "omni", "rag/sql_query", required=False, baseline=False)
    await db.commit()
    assert await prefs.read_prefs(db, "u1", "omni") == (set(), set(), {})


@pytest.mark.asyncio
async def test_returning_to_the_baseline_deletes_the_row(db):
    await prefs.set_approval(db, "u1", "omni", "write_file", required=False, baseline=True)
    await prefs.set_approval(db, "u1", "omni", "write_file", required=True, baseline=True)
    await db.commit()
    assert await prefs.read_prefs(db, "u1", "omni") == (set(), set(), {})


@pytest.mark.asyncio
async def test_the_two_axes_survive_each_other(db):
    # Turning the tool back on must not silently drop its approval gate.
    await prefs.set_enabled(db, "u1", "omni", "rag/sql_query", enabled=False, declared=True)
    await prefs.set_approval(db, "u1", "omni", "rag/sql_query", required=True, baseline=False)
    await prefs.set_enabled(db, "u1", "omni", "rag/sql_query", enabled=True, declared=True)
    await db.commit()

    disabled, _, approvals = await prefs.read_prefs(db, "u1", "omni")
    assert disabled == set()
    assert approvals == {"rag/sql_query": True}


# ---------------------------------------------------------------------------
# Overlaying onto the baseline
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_the_baseline_passes_through_untouched(db, rows):
    applied = await _apply(db, rows)
    assert _by_key(applied, "enabled") == {
        "write_file": True,
        "execute": True,
        "rag/sql_query": True,
        "arxiv/download_paper": False,
    }
    assert _by_key(applied, "approval") == {
        "write_file": True,
        "execute": True,
        "rag/sql_query": False,
        "arxiv/download_paper": False,
    }


@pytest.mark.asyncio
async def test_a_builtin_stays_enabled_whatever_is_stored(db, rows):
    # Enablement is MCP-only; a stray row naming a builtin must not switch it
    # off, since nothing downstream could honour that anyway.
    await prefs.set_enabled(db, "u1", "omni", "write_file", enabled=False, declared=True)
    await db.commit()
    assert _by_key(await _apply(db, rows), "enabled")["write_file"] is True


@pytest.mark.asyncio
async def test_a_user_choice_overrides_the_baseline_both_ways(db, rows):
    await prefs.set_approval(db, "u1", "omni", "write_file", required=False, baseline=True)
    await prefs.set_approval(db, "u1", "omni", "rag/sql_query", required=True, baseline=False)
    await db.commit()

    approvals = _by_key(await _apply(db, rows), "approval")
    assert approvals["write_file"] is False
    assert approvals["rag/sql_query"] is True


@pytest.mark.asyncio
async def test_a_locked_gate_is_reported_on_whatever_is_stored(db, rows):
    # The store should never hold this (the caller refuses it), but reporting it
    # off would show a live switch for a control that does nothing.
    await prefs.set_approval(db, "u1", "omni", "execute", required=False, baseline=True)
    await db.commit()
    assert _by_key(await _apply(db, rows), "approval")["execute"] is True


@pytest.mark.asyncio
async def test_a_choice_for_a_tool_that_no_longer_exists_is_ignored(db, rows):
    # An MCP server can disappear from the gateway. The stale row stays — it
    # costs nothing and the tool may come back — but must not invent a row.
    await prefs.set_enabled(db, "u1", "omni", "gone/vanished", enabled=True, declared=False)
    await db.commit()
    applied = await _apply(db, rows)
    assert [r["key"] for r in applied] == [r["key"] for r in rows]
