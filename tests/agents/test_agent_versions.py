"""``describe_changes`` — the parts of an agent a save touched.

What the History tab lists next to each version ("instructions, tools"), stored
with the version when it is written. Pure functions over a spec dict and
``{path: (content, encoding)}``, so no database and no service import beyond
the module itself.
"""
from __future__ import annotations

import pytest

PROMPT = "AGENT.md"


def _spec(**overrides):
    spec = {
        "id": "helper-v1",
        "slug": "helper",
        "name": "Helper",
        "version": "1.0.0",
        "type": "deep_agent",
        "description": "Helps.",
        "icon": "bot",
        "prompt": "./AGENT.md",
        "model": {"main": "openai:gpt-5", "subagents": {}},
        "tools": [],
        "skills": [],
        "subagents": [],
        "hitl": {},
        "memory": False,
    }
    spec.update(overrides)
    return spec


def _files(**extra):
    return {PROMPT: ("You help.", "utf-8"), **{k: (v, "utf-8") for k, v in extra.items()}}


@pytest.fixture()
def versions(agents_service):
    return agents_service.agent_versions


def test_identical_states_change_nothing(versions):
    assert versions.describe_changes((_spec(), _files()), (_spec(), _files())) == []


@pytest.mark.parametrize(
    ("after", "part"),
    [
        (_spec(name="Helper 2"), "details"),
        (_spec(description="Helps more."), "details"),
        (_spec(icon="star"), "details"),
        (_spec(model={"main": "openai:gpt-4o", "subagents": {}}), "model"),
        (_spec(tools=[{"native": "read_file"}]), "tools"),
        (_spec(hitl={"write_file": False}), "tools"),
        (_spec(skills=["notes"]), "skills"),
        (_spec(subagents=[{"name": "w", "description": "W.", "prompt": "./subagents/w.md"}]), "team"),
        (_spec(model={"main": "openai:gpt-5", "subagents": {"w": "openai:gpt-4o"}}), "team"),
        (_spec(memory=True), "settings"),
    ],
)
def test_each_spec_field_lands_in_its_part(versions, after, part):
    assert versions.describe_changes((_spec(), _files()), (after, _files())) == [part]


def test_the_main_prompt_is_instructions(versions):
    after = {PROMPT: ("You help, carefully.", "utf-8")}
    assert versions.describe_changes((_spec(), _files()), (_spec(), after)) == ["instructions"]


def test_a_subagent_prompt_is_team_and_other_files_are_files(versions):
    before = _files(**{"subagents/w.md": "Write."})
    assert versions.describe_changes(
        (_spec(), before), (_spec(), _files(**{"subagents/w.md": "Write well."}))
    ) == ["team"]
    assert versions.describe_changes(
        (_spec(), before), (_spec(), {**before, "notes.md": ("Ref.", "utf-8")})
    ) == ["files"]


def test_an_inline_prompt_is_compared_as_instructions(versions):
    # No file behind ``prompt:`` — the spec text itself is the instructions.
    before = (_spec(prompt="You help."), {})
    after = (_spec(prompt="You help, carefully."), {})
    assert versions.describe_changes(before, after) == ["instructions"]


def test_bookkeeping_fields_are_never_a_change(versions):
    # The builder may rewrite these on any save; on their own they are no edit.
    after = _spec(id="helper-v2", version="1.0.1", type="other")
    assert versions.describe_changes((_spec(), _files()), (after, _files())) == []


def test_a_key_that_appears_or_disappears_counts_as_settings(versions):
    spec = _spec()
    spec.pop("memory")
    assert versions.describe_changes((_spec(), _files()), (spec, _files())) == ["settings"]


def test_several_parts_come_back_in_the_tabs_order(versions):
    after = _spec(skills=["notes"], name="Renamed", model={"main": "openai:gpt-4o", "subagents": {}})
    files = {PROMPT: ("New.", "utf-8"), "notes.md": ("Ref.", "utf-8")}
    assert versions.describe_changes((_spec(), _files()), (after, files)) == [
        "details", "instructions", "model", "skills", "files",
    ]
    assert list(versions.CHANGE_ORDER) == [
        "details", "instructions", "model", "tools", "skills", "team", "files", "settings",
    ]


def test_the_kinds_and_no_cap(versions):
    assert not hasattr(versions, "MAX_VERSIONS")
    assert set(versions.KINDS) == {"created", "saved", "restored", "baseline"}
