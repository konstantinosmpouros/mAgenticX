"""The volume half of the reconciliation exchange.

This service reports what its volume holds and applies what the bridge decides.
Both halves are dangerous in their own way — a wrong inventory makes the bridge
plan the wrong repair, and applying a plan is the only path in the system that
deletes a user's authored content — so the branch conditions are pinned here
rather than left to the live pass.
"""
from __future__ import annotations

import importlib

import pytest


# The hash is a CROSS-SERVICE contract: the bridge computes it over its stored
# rows, this service over the folder on disk, and the plan compares the two. If
# they ever disagree every pass rewrites every file, silently. These literals are
# the same in tests/dialogue_bridge/test_workspace_sync.py — changing one without
# the other is the failure this pins.
GOLDEN = "72124c6dce55c9a2e40157710f579845ce22b904ad93e2be23a485359a1d32b5"
GOLDEN_FILES = [("SKILL.md", "# Note taker\n"), ("scripts/run.py", "print(1)\n")]
GOLDEN_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


@pytest.fixture
def sync(skills_fs):
    """The module under test, bound to the tmp volume ``skills_fs`` set up."""
    return importlib.import_module("utils.workspace_sync")


@pytest.fixture
def spec_for(skills_fs):
    def _make(slug: str, name: str = "Probe"):
        return {
            "id": f"{slug}-v1",
            "slug": slug,
            "name": name,
            "version": "1.0.0",
            "type": "deep_agent",
            "description": "d",
            "icon": "Bot",
            "prompt": "./AGENT.md",
            "model": {"main": "gpt-4o-mini"},
        }

    return _make


# ---------------------------------------------------------------------------
# The hash contract
# ---------------------------------------------------------------------------
def test_hash_matches_the_bridge_byte_for_byte(sync):
    assert sync.content_hash(GOLDEN_FILES) == GOLDEN
    assert sync.content_hash([]) == GOLDEN_EMPTY


def test_hash_ignores_order_and_newline_style(sync):
    a = sync.content_hash([("b.md", "two\r\nlines"), ("a.md", "one")])
    b = sync.content_hash([("a.md", "one"), ("b.md", "two\nlines")])
    assert a == b


# ---------------------------------------------------------------------------
# Reading the volume
# ---------------------------------------------------------------------------
def test_volume_users_include_one_the_bridge_has_never_heard_of(sync, skills_fs):
    # The orphan case: a workspace with no chat_db rows. Syncing only the
    # bridge's user list would leave it invisible forever, which is the bug the
    # union exists to fix.
    (skills_fs.users_root / "ghost-user").mkdir(parents=True, exist_ok=True)
    assert "ghost-user" in sync._volume_user_ids()


def test_inventory_reports_an_agent_with_its_hash(sync, skills_fs, spec_for):
    from harness.abstractions import AgentSpec
    from harness.abstractions.user_agents import write_user_agent
    from schema import AgentFile

    write_user_agent(
        "u1",
        AgentSpec.model_validate(spec_for("probe-bot")),
        [AgentFile(path="AGENT.md", content="Hello.", encoding="utf-8")],
    )
    inv = sync.build_inventory("u1")
    assert [a["slug"] for a in inv["agents"]] == ["probe-bot"]
    # agent.yaml is generated here and never stored by the bridge, so counting
    # it would make every comparison mismatch.
    assert inv["agents"][0]["hash"] == sync.content_hash([("AGENT.md", "Hello.")])


def test_inventory_reports_a_global_entry_without_a_hash(sync, skills_fs):
    from harness.skill_registry.user_registry import add_global_to_user

    add_global_to_user("u1", "deep-research")
    inv = sync.build_inventory("u1")
    entry = next(s for s in inv["skills"] if s["name"] == "deep-research")
    assert entry["type"] == "global" and entry["hash"] == ""


def test_inventory_reports_assignments_per_agent(sync, skills_fs):
    from harness.skill_registry.user_registry import (
        add_global_to_user,
        assign_user_skill_to_agent,
    )

    add_global_to_user("u1", "deep-research")
    assign_user_skill_to_agent(user_id="u1", agent_slug="omni", skill_name="deep-research")
    assert sync.build_inventory("u1")["assignments"] == {"omni": ["deep-research"]}


# ---------------------------------------------------------------------------
# Applying a plan
# ---------------------------------------------------------------------------
def test_writing_an_agent_materialises_it(sync, skills_fs, spec_for):
    from harness.abstractions.user_agents import list_user_agents

    assert sync._write_agent("u1", {"slug": "probe-bot", "spec": spec_for("probe-bot"),
                                    "files": [{"path": "AGENT.md", "content": "x"}]}) is True
    assert [a.slug for a in list_user_agents("u1")] == ["probe-bot"]


def test_an_unparseable_spec_is_skipped_not_raised(sync, skills_fs):
    # A definition chat_db holds that this build cannot parse — an older shape,
    # a model since removed. Failing here would abort the whole user's pass and
    # block every other repair; the definition is still safe in Postgres.
    assert sync._write_agent("u1", {"slug": "bad", "spec": {"nonsense": True}, "files": []}) is False


def test_writing_a_skill_that_already_exists_replaces_it(sync, skills_fs):
    from harness.skill_registry.user_registry import get_user_skill_detail

    item = {"name": "note-taker", "type": "custom", "description": "d",
            "files": [{"path": "SKILL.md", "content": "v1"}]}
    assert sync._write_skill("u1", item, set()) is True

    # `add_custom_to_user` refuses a name already in the pool, so a rewrite has
    # to remove first — otherwise a diverged skill could never be repaired.
    item["files"] = [{"path": "SKILL.md", "content": "v2"}]
    assert sync._write_skill("u1", item, {"note-taker"}) is True
    body = get_user_skill_detail("u1", "note-taker").files[0].content
    assert "v2" in body


def test_a_skill_with_no_files_is_not_written(sync, skills_fs):
    # Metadata with no bodies would create an empty folder over content the
    # volume may still hold.
    assert sync._write_skill("u1", {"name": "empty", "type": "custom", "files": []}, set()) is False


def test_removing_finishes_a_deletion(sync, skills_fs, spec_for):
    from harness.abstractions import AgentSpec
    from harness.abstractions.user_agents import list_user_agents, write_user_agent
    from harness.skill_registry.user_registry import add_global_to_user, read_user_manifest
    from schema import AgentFile

    write_user_agent("u1", AgentSpec.model_validate(spec_for("probe-bot")),
                     [AgentFile(path="AGENT.md", content="x", encoding="utf-8")])
    add_global_to_user("u1", "deep-research")

    assert sync._remove_agent("u1", "probe-bot") is True
    assert sync._remove_skill("u1", "deep-research") is True
    assert list_user_agents("u1") == []
    assert [e.name for e in read_user_manifest("u1").skills] == []


def test_removing_something_already_gone_is_not_an_error(sync, skills_fs):
    # Passes are idempotent: a plan may name a removal a previous pass completed.
    assert sync._remove_agent("u1", "never-existed") is False


# ---------------------------------------------------------------------------
# Handing content back
# ---------------------------------------------------------------------------
def test_collecting_agent_content_returns_spec_and_files(sync, skills_fs, spec_for):
    from harness.abstractions import AgentSpec
    from harness.abstractions.user_agents import write_user_agent
    from schema import AgentFile

    write_user_agent("u1", AgentSpec.model_validate(spec_for("probe-bot")),
                     [AgentFile(path="AGENT.md", content="Hello.", encoding="utf-8")])
    out = sync._collect_agent_content("u1", ["probe-bot", "missing-bot"])
    assert [a["slug"] for a in out] == ["probe-bot"]
    assert out[0]["spec"]["slug"] == "probe-bot"
    assert [f["path"] for f in out[0]["files"]] == ["AGENT.md"]


def test_collecting_skill_content_skips_globals(sync, skills_fs):
    # A global has no per-user body to hand over; the catalogue owns it and the
    # bridge records membership from the inventory alone.
    from harness.skill_registry.user_registry import add_global_to_user

    add_global_to_user("u1", "deep-research")
    assert sync._collect_skill_content("u1", ["deep-research"]) == []


def test_collecting_skill_content_returns_the_bodies(sync, skills_fs):
    sync._write_skill(
        "u1",
        {"name": "note-taker", "type": "custom", "description": "d",
         "files": [{"path": "SKILL.md", "content": "body"}]},
        set(),
    )
    out = sync._collect_skill_content("u1", ["note-taker"])
    assert len(out) == 1 and out[0]["name"] == "note-taker"
    assert any(f["path"] == "SKILL.md" for f in out[0]["files"])
