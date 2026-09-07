"""The two-way reconciliation between chat_db and the agents-service volume.

The exchange answers an inventory with three lists — write, send, remove — and
each one has a failure mode of its own: a missed *write* leaves a wiped volume
empty, a missed *send* leaves an orphan invisible forever, and a wrong *remove*
destroys content. These pin the branch conditions, none of which is reachable
from the HTTP surface without a live agents service.
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import select

from core.database import AgentTable
from schema import (
    ContentAgent,
    ContentSkill,
    InventoryAgent,
    InventorySkill,
    SyncContent,
    SyncInventory,
)
from utils import skill_store, user_agents, workspace_sync
from utils.workspace_sync import build_plan, content_hash

SPEC = {"slug": "research-bot", "name": "Research Bot", "version": "1", "description": "d"}
FILES = [{"path": "AGENT.md", "content": "You are Research Bot."}]


@pytest_asyncio.fixture
async def db(session_factory):
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def uid(seeded_user):
    return seeded_user.id


async def _agent(db, uid, slug="research-bot", *, spec=True, active=True):
    row = AgentTable(
        owner_user_id=uid, slug=slug, name="Research Bot", description="d",
        icon="Bot", type="deep agent", is_active=active,
    )
    if spec:
        row.definition_spec = SPEC
    db.add(row)
    await db.flush()
    if spec:
        await user_agents._store_definition(db, row.id, {"files": FILES})
    await db.commit()
    return row


# ---------------------------------------------------------------------------
# The hash both services have to agree on
# ---------------------------------------------------------------------------
def test_hash_ignores_file_order_and_newline_style():
    a = content_hash([("b.md", "two\r\nlines"), ("a.md", "one")])
    b = content_hash([("a.md", "one"), ("b.md", "two\nlines")])
    assert a == b


def test_hash_changes_with_content():
    assert content_hash([("a.md", "one")]) != content_hash([("a.md", "two")])


def test_the_generated_manifest_is_excluded():
    # The agents service generates agent.yaml and the bridge never stores it,
    # so counting it would make every comparison mismatch.
    kept = workspace_sync._hashable(
        [{"path": "AGENT.md", "content": "x"}, {"path": workspace_sync.GENERATED_MANIFEST, "content": "y"}]
    )
    assert kept == [("AGENT.md", "x")]


# ---------------------------------------------------------------------------
# write — chat_db has it, the volume does not
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_an_agent_missing_from_the_volume_is_written_back(db, uid):
    await _agent(db, uid)
    plan = await build_plan(db, uid, SyncInventory())
    assert [a.slug for a in plan.write_agents] == ["research-bot"]
    assert plan.write_agents[0].spec == SPEC
    assert plan.send_agents == [] and plan.remove_agents == []


@pytest.mark.asyncio
async def test_a_matching_hash_produces_no_work(db, uid):
    await _agent(db, uid)
    inv = SyncInventory(
        agents=[InventoryAgent(slug="research-bot", hash=content_hash([("AGENT.md", FILES[0]["content"])]))]
    )
    plan = await build_plan(db, uid, inv)
    assert plan.write_agents == [] and plan.send_agents == [] and plan.remove_agents == []


@pytest.mark.asyncio
async def test_a_diverged_folder_is_rewritten_from_chat_db(db, uid):
    await _agent(db, uid)
    inv = SyncInventory(agents=[InventoryAgent(slug="research-bot", hash="stale")])
    plan = await build_plan(db, uid, inv)
    assert [a.slug for a in plan.write_agents] == ["research-bot"]


@pytest.mark.asyncio
async def test_a_platform_agent_is_never_materialised(db, uid):
    # owner_user_id IS NULL means the definition ships in the image; writing one
    # would shadow the shipped copy.
    db.add(AgentTable(owner_user_id=None, slug="omni", name="Omni", description="",
                      icon="Bot", type="deep agent", is_active=True))
    await db.commit()
    plan = await build_plan(db, uid, SyncInventory())
    assert plan.write_agents == [] and plan.send_agents == []


# ---------------------------------------------------------------------------
# send — the volume has it, chat_db does not (the orphan)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_folder_with_no_row_is_requested(db, uid):
    # The half-failed create: invisible in the UI and 409 on retry today.
    inv = SyncInventory(agents=[InventoryAgent(slug="ghost-bot", hash="h")])
    plan = await build_plan(db, uid, inv)
    assert plan.send_agents == ["ghost-bot"]
    assert plan.write_agents == []


@pytest.mark.asyncio
async def test_a_row_without_a_definition_asks_for_content_not_a_write(db, uid):
    # Pre-dates the definition store. Writing an empty folder would destroy the
    # only copy that exists.
    await _agent(db, uid, spec=False)
    inv = SyncInventory(agents=[InventoryAgent(slug="research-bot", hash="h")])
    plan = await build_plan(db, uid, inv)
    assert plan.send_agents == ["research-bot"] and plan.write_agents == []


@pytest.mark.asyncio
async def test_a_pool_entry_without_bodies_asks_for_content(db, uid):
    await skill_store.add_to_pool(db, uid, "note-taker", pool_type="custom")
    await db.commit()
    inv = SyncInventory(skills=[InventorySkill(name="note-taker", hash="h")])
    plan = await build_plan(db, uid, inv)
    assert plan.send_skills == ["note-taker"] and plan.write_skills == []


@pytest.mark.asyncio
async def test_a_skill_folder_with_no_pool_row_is_requested(db, uid):
    inv = SyncInventory(skills=[InventorySkill(name="orphan-skill", hash="h")])
    plan = await build_plan(db, uid, inv)
    assert plan.send_skills == ["orphan-skill"]


@pytest.mark.asyncio
async def test_a_global_entry_compares_by_presence_only(db, uid):
    # The catalogue owns the content, so there is no per-user copy to hash.
    await skill_store.add_to_pool(db, uid, "web-research", pool_type="global")
    await db.commit()
    plan = await build_plan(db, uid, SyncInventory())
    assert [s.name for s in plan.write_skills] == ["web-research"]
    assert plan.write_skills[0].type == "global" and plan.write_skills[0].files == []

    inv = SyncInventory(skills=[InventorySkill(name="web-research", type="global")])
    assert (await build_plan(db, uid, inv)).write_skills == []


# ---------------------------------------------------------------------------
# remove — a tombstone means finish the deletion
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_deleted_agent_still_on_the_volume_is_removed(db, uid):
    await _agent(db, uid, active=False)
    inv = SyncInventory(agents=[InventoryAgent(slug="research-bot", hash="h")])
    plan = await build_plan(db, uid, inv)
    assert plan.remove_agents == ["research-bot"]
    assert plan.write_agents == [] and plan.send_agents == []


@pytest.mark.asyncio
async def test_a_tombstoned_skill_still_on_the_volume_is_removed(db, uid):
    await skill_store.store_custom_skill(db, uid, name="note-taker", files=FILES)
    await skill_store.tombstone_pool_entry(db, uid, "note-taker")
    await db.commit()
    inv = SyncInventory(skills=[InventorySkill(name="note-taker", hash="h")])
    plan = await build_plan(db, uid, inv)
    assert plan.remove_skills == ["note-taker"]
    assert plan.write_skills == [] and plan.send_skills == []


# ---------------------------------------------------------------------------
# assignments — adopted inline, no second round trip
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_volume_only_assignments_are_adopted_and_returned(db, uid):
    await skill_store.add_to_pool(db, uid, "note-taker", pool_type="custom")
    await db.commit()
    inv = SyncInventory(assignments={"omni": ["note-taker"]})
    plan = await build_plan(db, uid, inv)
    await db.commit()

    assert plan.assignments == {"omni": ["note-taker"]}
    assert await skill_store.list_agent_skills(db, uid, "omni") == ["note-taker"]


@pytest.mark.asyncio
async def test_an_assignment_for_a_removed_skill_is_not_adopted(db, uid):
    await skill_store.store_custom_skill(db, uid, name="note-taker", files=FILES)
    await skill_store.tombstone_pool_entry(db, uid, "note-taker")
    await db.commit()

    plan = await build_plan(db, uid, SyncInventory(assignments={"omni": ["note-taker"]}))
    await db.commit()
    assert plan.assignments == {}
    assert await skill_store.list_agent_skills(db, uid, "omni") == []


# ---------------------------------------------------------------------------
# content — adopting the bodies a plan asked for
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_adopting_an_orphan_creates_the_row_and_its_definition(db, uid):
    counts = await workspace_sync.apply_content(
        db, uid, SyncContent(agents=[ContentAgent(slug="ghost-bot", spec={**SPEC, "slug": "ghost-bot"}, files=FILES)])
    )
    await db.commit()

    assert counts["agents"] == 1
    items = await user_agents.list_custom_agent_definitions(db, uid)
    assert [i["slug"] for i in items] == ["ghost-bot"]
    detail = await user_agents.get_custom_agent_definition(db, uid, items[0]["id"])
    assert [f["path"] for f in detail["files"]] == ["AGENT.md"]


@pytest.mark.asyncio
async def test_adoption_will_not_revive_a_deleted_agent(db, uid):
    # The dormant row IS the tombstone; reactivating it here would undo a delete
    # whose volume half simply had not landed yet.
    await _agent(db, uid, active=False)
    counts = await workspace_sync.apply_content(
        db, uid, SyncContent(agents=[ContentAgent(slug="research-bot", spec=SPEC, files=FILES)])
    )
    await db.commit()

    assert counts["agents"] == 0
    row = (
        await db.execute(select(AgentTable).where(AgentTable.slug == "research-bot"))
    ).scalar_one()
    assert row.is_active is False


@pytest.mark.asyncio
async def test_adoption_will_not_revive_a_removed_skill(db, uid):
    await skill_store.store_custom_skill(db, uid, name="note-taker", files=FILES)
    await skill_store.tombstone_pool_entry(db, uid, "note-taker")
    await db.commit()

    counts = await workspace_sync.apply_content(
        db, uid, SyncContent(skills=[ContentSkill(name="note-taker", files=FILES)])
    )
    await db.commit()

    assert counts["skills"] == 0
    assert await skill_store.list_pool(db, uid) == []


@pytest.mark.asyncio
async def test_adopting_a_skill_makes_it_visible_and_hashable(db, uid):
    await workspace_sync.apply_content(
        db, uid, SyncContent(skills=[ContentSkill(name="note-taker", description="d", files=FILES)])
    )
    await db.commit()

    assert [p["name"] for p in await skill_store.list_pool(db, uid)] == ["note-taker"]
    # And the next pass sees it as settled rather than re-sending it.
    inv = SyncInventory(
        skills=[InventorySkill(name="note-taker", hash=content_hash([("AGENT.md", FILES[0]["content"])]))]
    )
    plan = await build_plan(db, uid, inv)
    assert plan.send_skills == [] and plan.write_skills == []


@pytest.mark.asyncio
async def test_an_entry_with_no_content_on_either_side_is_dropped(db, uid):
    # A name we hold with no files, and no folder on the volume: the skill
    # exists nowhere, so the entry can only ever 404. The read-triggered
    # stale-prune used to clean this up, but only if somebody opened it.
    await skill_store.add_to_pool(db, uid, "ghost-skill", pool_type="custom")
    await db.commit()

    plan = await build_plan(db, uid, SyncInventory())
    await db.commit()

    assert plan.send_skills == [] and plan.write_skills == []
    assert await skill_store.list_pool(db, uid) == []


# ---------------------------------------------------------------------------
# The cross-service hash contract
# ---------------------------------------------------------------------------
# The bridge computes this over its stored rows, the agents service over the
# folder on disk, and the plan compares the two. If they ever disagree, every
# pass rewrites every file — silently, because a mismatch looks exactly like a
# diverged folder. These literals are duplicated in
# tests/agents/test_workspace_sync.py; changing one without the other is the
# failure they exist to catch.
GOLDEN = "72124c6dce55c9a2e40157710f579845ce22b904ad93e2be23a485359a1d32b5"
GOLDEN_FILES = [("SKILL.md", "# Note taker\n"), ("scripts/run.py", "print(1)\n")]
GOLDEN_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_hash_matches_the_agents_service_byte_for_byte():
    assert content_hash(GOLDEN_FILES) == GOLDEN
    assert content_hash([]) == GOLDEN_EMPTY
