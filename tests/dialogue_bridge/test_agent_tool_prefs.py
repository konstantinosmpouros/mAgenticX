"""Per-(user, agent) tool overrides live in chat_db.

They lived only in ``tool_prefs.json`` on the agents-service volume, which has
no backup — losing it silently reverted every user's tool choices to the agent's
declared baseline, a change nobody is told about and which reads as the product
forgetting a setting.

The subtlety worth pinning is that one UI boolean means two different things.
For a tool the agent *declares* (on by default) "off" is a stored override and
"on" is the absence of one; for an undeclared gateway tool it is the mirror
image. Getting that backwards fills the table with rows meaning "normal" — or,
worse, makes a toggle look like it did nothing.
"""

import pytest
import pytest_asyncio

from utils import agent_tool_prefs as prefs


@pytest_asyncio.fixture
async def db(session_factory):
    """A real session — these overrides are rows, not a proxied call."""
    async with session_factory() as session:
        yield session


@pytest.fixture
def rows():
    """A manifest as the agents service reports it: two declared, one not."""
    return [
        {"key": "write_file", "name": "write_file", "source": "native",
         "declared": True, "disabled": False},
        {"key": "rag/sql_query", "name": "sql_query", "source": "mcp",
         "declared": True, "disabled": False},
        {"key": "arxiv/download_paper", "name": "download_paper", "source": "mcp",
         "declared": False, "disabled": True},
    ]


def _by_key(applied):
    return {r["key"]: r["disabled"] for r in applied}


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_pair_with_no_overrides_reads_as_two_empty_sets(db):
    # Not an error state — it means "the agent's declared baseline", which is
    # exactly what the caller should apply.
    assert await prefs.read_pair(db, "u1", "omni") == (set(), set())


@pytest.mark.asyncio
async def test_disabled_and_enabled_come_back_separated(db):
    await prefs.set_override(db, "u1", "omni", "rag/sql_query", prefs.STATE_DISABLED)
    await prefs.set_override(db, "u1", "omni", "arxiv/download_paper", prefs.STATE_ENABLED)
    await db.commit()

    disabled, enabled = await prefs.read_pair(db, "u1", "omni")
    assert disabled == {"rag/sql_query"}
    assert enabled == {"arxiv/download_paper"}


@pytest.mark.asyncio
async def test_overrides_do_not_leak_across_agents_or_users(db):
    # The pairing is the unit. A tool disabled for one agent says nothing about
    # the same tool on another.
    await prefs.set_override(db, "u1", "omni", "rag/sql_query", prefs.STATE_DISABLED)
    await db.commit()

    assert await prefs.read_pair(db, "u1", "other-agent") == (set(), set())
    assert await prefs.read_pair(db, "u2", "omni") == (set(), set())


@pytest.mark.asyncio
async def test_a_key_cannot_be_both_disabled_and_enabled(db):
    # One row per key with a state column makes the contradiction unrepresentable
    # rather than a rule two tables would have to agree to keep.
    await prefs.set_override(db, "u1", "omni", "rag/sql_query", prefs.STATE_DISABLED)
    await prefs.set_override(db, "u1", "omni", "rag/sql_query", prefs.STATE_ENABLED)
    await db.commit()

    disabled, enabled = await prefs.read_pair(db, "u1", "omni")
    assert disabled == set() and enabled == {"rag/sql_query"}


@pytest.mark.asyncio
async def test_an_unknown_state_is_refused(db):
    with pytest.raises(ValueError):
        await prefs.set_override(db, "u1", "omni", "x", "maybe")


# ---------------------------------------------------------------------------
# What a toggle means depends on the tool's default
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_turning_a_declared_tool_off_stores_an_override(db):
    await prefs.apply_toggle(db, "u1", "omni", "rag/sql_query", disabled=True, declared=True)
    await db.commit()
    assert (await prefs.read_pair(db, "u1", "omni"))[0] == {"rag/sql_query"}


@pytest.mark.asyncio
async def test_turning_a_declared_tool_back_on_clears_it(db):
    # Back-to-default is a deleted row, not a stored opposite — otherwise every
    # tool a user ever glanced at accumulates a row saying "normal".
    await prefs.apply_toggle(db, "u1", "omni", "rag/sql_query", disabled=True, declared=True)
    await prefs.apply_toggle(db, "u1", "omni", "rag/sql_query", disabled=False, declared=True)
    await db.commit()
    assert await prefs.read_pair(db, "u1", "omni") == (set(), set())


@pytest.mark.asyncio
async def test_turning_an_undeclared_tool_on_stores_an_override(db):
    await prefs.apply_toggle(
        db, "u1", "omni", "arxiv/download_paper", disabled=False, declared=False
    )
    await db.commit()
    assert (await prefs.read_pair(db, "u1", "omni"))[1] == {"arxiv/download_paper"}


@pytest.mark.asyncio
async def test_turning_an_undeclared_tool_off_clears_it(db):
    await prefs.apply_toggle(
        db, "u1", "omni", "arxiv/download_paper", disabled=False, declared=False
    )
    await prefs.apply_toggle(
        db, "u1", "omni", "arxiv/download_paper", disabled=True, declared=False
    )
    await db.commit()
    assert await prefs.read_pair(db, "u1", "omni") == (set(), set())


# ---------------------------------------------------------------------------
# Overlaying onto the manifest
# ---------------------------------------------------------------------------
def test_the_baseline_is_declared_on_undeclared_off(rows):
    # With no overrides at all, the agents service's own `disabled` flags are
    # ignored and recomputed — it no longer owns the user's choices.
    applied = _by_key(prefs.apply_to_rows(rows, set(), set()))
    assert applied == {
        "write_file": False,
        "rag/sql_query": False,
        "arxiv/download_paper": True,
    }


def test_overrides_flip_both_directions(rows):
    applied = _by_key(
        prefs.apply_to_rows(rows, {"rag/sql_query"}, {"arxiv/download_paper"})
    )
    assert applied["rag/sql_query"] is True        # declared, turned off
    assert applied["arxiv/download_paper"] is False  # undeclared, turned on
    assert applied["write_file"] is False          # untouched


def test_an_override_for_a_tool_that_no_longer_exists_is_ignored(rows):
    # An MCP server can disappear from the gateway. The stale row stays (it costs
    # nothing and the tool may come back) but must not invent a row in the list.
    applied = prefs.apply_to_rows(rows, {"gone/vanished"}, set())
    assert [r["key"] for r in applied] == [r["key"] for r in rows]


# ---------------------------------------------------------------------------
# Adoption — the volume copy that pre-dates this table
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_adoption_takes_both_sets_from_the_volume(db):
    # Dennis holds a real one of these: enabledTools ["arxiv/download_paper"].
    # Losing it silently turns that user's tool back off.
    n = await prefs.adopt_pair(
        db, "u1", "omni-yaml-v1",
        disabled=["rag/sql_query"], enabled=["arxiv/download_paper"],
    )
    await db.commit()

    assert n == 2
    disabled, enabled = await prefs.read_pair(db, "u1", "omni-yaml-v1")
    assert disabled == {"rag/sql_query"} and enabled == {"arxiv/download_paper"}


@pytest.mark.asyncio
async def test_the_gate_is_the_marker_not_the_presence_of_overrides(db):
    # An ordinary override must NOT count as "adopted" — otherwise a pair that
    # never had a legacy file would look adopted, and one that was adopted then
    # cleared would look un-adopted.
    assert await prefs.has_adopted(db, "u1", "omni") is False
    await prefs.set_override(db, "u1", "omni", "rag/sql_query", prefs.STATE_DISABLED)
    await db.commit()
    assert await prefs.has_adopted(db, "u1", "omni") is False

    await prefs.adopt_pair(db, "u1", "omni", disabled=[], enabled=[])
    await db.commit()
    assert await prefs.has_adopted(db, "u1", "omni") is True


@pytest.mark.asyncio
async def test_clearing_the_last_override_does_not_reopen_adoption(db):
    # The bug this marker exists for: adopt an enabled gateway tool, let the user
    # turn it back off (which deletes the row), and the pair must still read as
    # adopted — otherwise the next tab load re-applies the stale file and
    # silently undoes the user's change.
    await prefs.adopt_pair(db, "u1", "omni", disabled=[], enabled=["arxiv/download_paper"])
    await db.commit()
    await prefs.apply_toggle(
        db, "u1", "omni", "arxiv/download_paper", disabled=True, declared=False
    )
    await db.commit()

    assert await prefs.read_pair(db, "u1", "omni") == (set(), set())
    assert await prefs.has_adopted(db, "u1", "omni") is True


@pytest.mark.asyncio
async def test_the_marker_never_leaks_into_a_tool_set(db):
    await prefs.adopt_pair(db, "u1", "omni", disabled=[], enabled=[])
    await db.commit()
    disabled, enabled = await prefs.read_pair(db, "u1", "omni")
    assert prefs.ADOPTION_KEY not in disabled and prefs.ADOPTION_KEY not in enabled


@pytest.mark.asyncio
async def test_adopting_an_empty_file_writes_nothing(db):
    # Most tool_prefs.json files are empty. Adoption stays "un-run" for them,
    # which is harmless: the check rides a call that happens anyway.
    assert await prefs.adopt_pair(db, "u1", "omni", disabled=[], enabled=[]) == 0
    await db.commit()
    # …but it is still recorded as read, so it is not re-read forever.
    assert await prefs.has_adopted(db, "u1", "omni") is True
    assert await prefs.read_pair(db, "u1", "omni") == (set(), set())
