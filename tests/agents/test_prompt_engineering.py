"""Composing a deep agent's system prompt.

The rule every case here defends: **a section may only describe something the
run actually has.** That is not tidiness — an agent told about a mount it lacks
tries it, fails, and then distrusts the rest of its prompt. The flags that build
the mounts are the flags that build the text.

The second rule is that the user's instructions lead and are never rewritten.
A custom agent's 56-byte prompt was what started this: it had every mount and
every file tool, was told about none of them, and spent four turns insisting it
could not browse a filesystem.
"""
from __future__ import annotations

import importlib
from datetime import datetime, timezone

import pytest


@pytest.fixture
def pe(agents_service):
    return importlib.import_module("harness.prompt_engineering")


@pytest.fixture
def full(pe):
    """A run with everything switched on."""
    return pe.PromptContext(
        use_memory=True,
        has_conversation=True,
        has_reference=True,
        has_default_skills=True,
        search_past_convs=True,
        sandbox_enabled=True,
        has_subagents=True,
        now=datetime(2026, 9, 15, 17, 23, tzinfo=timezone.utc),
        personalization="## How To Talk To This User\n\nBe brief.",
    )


# ---------------------------------------------------------------------------
# The user's instructions lead
# ---------------------------------------------------------------------------
def test_the_instructions_come_first_and_are_untouched(pe, full):
    instructions = "You are a good friend that helps me with whatever l want"
    out = pe.compose_system_prompt(instructions, full)

    assert out.startswith(instructions)
    assert instructions in out


def test_an_empty_run_composes_to_exactly_the_instructions(pe):
    # Nothing enabled: the prompt must be byte-identical to what was authored,
    # so adding this package changed no existing agent's behaviour by default.
    out = pe.compose_system_prompt("Be helpful.", pe.PromptContext())
    assert out == "Be helpful."


def test_no_instructions_yields_the_platform_sections_alone(pe, full):
    out = pe.compose_system_prompt(None, full)
    assert out
    assert "## Your Workspace" in out


def test_surrounding_whitespace_in_instructions_is_trimmed(pe):
    assert pe.compose_system_prompt("  Be helpful.\n\n", pe.PromptContext()) == "Be helpful."


# ---------------------------------------------------------------------------
# A section appears only when its feature does
# ---------------------------------------------------------------------------
def test_memory_is_described_only_when_it_is_mounted(pe):
    on = pe.compose_system_prompt("x", pe.PromptContext(use_memory=True))
    off = pe.compose_system_prompt("x", pe.PromptContext(use_memory=False))

    assert "/memories/AGENTS.md" in on
    assert "/memories/" not in off


def test_past_conversation_search_needs_its_own_opt_in(pe):
    both = pe.compose_system_prompt("x", pe.PromptContext(use_memory=True, search_past_convs=True))
    memory_only = pe.compose_system_prompt("x", pe.PromptContext(use_memory=True))

    assert "search_past_conversations" in both
    assert "search_past_conversations" not in memory_only


def test_the_workspace_is_described_only_with_a_conversation(pe):
    with_conv = pe.compose_system_prompt("x", pe.PromptContext(has_conversation=True))
    without = pe.compose_system_prompt("x", pe.PromptContext())

    assert "/conversation/input/" in with_conv
    assert "/conversation/" not in without


def test_reference_is_described_only_when_mounted(pe):
    # A code-defined agent has no definition folder; its package is source and
    # is never mounted, so the section must not appear.
    with_ref = pe.compose_system_prompt(
        "x", pe.PromptContext(has_conversation=True, has_reference=True)
    )
    without = pe.compose_system_prompt("x", pe.PromptContext(has_conversation=True))

    assert "/reference/" in with_ref
    assert "/reference/" not in without


def test_default_skills_is_described_only_when_mounted(pe):
    with_ds = pe.compose_system_prompt(
        "x", pe.PromptContext(has_conversation=True, has_default_skills=True)
    )
    assert "/default_skills/" in with_ds
    assert "/default_skills/" not in pe.compose_system_prompt(
        "x", pe.PromptContext(has_conversation=True)
    )


def test_execute_is_described_only_when_the_sandbox_is_on(pe):
    on = pe.compose_system_prompt(
        "x", pe.PromptContext(has_conversation=True, sandbox_enabled=True)
    )
    off = pe.compose_system_prompt("x", pe.PromptContext(has_conversation=True))

    assert "`execute`" in on
    assert "`execute`" not in off


def test_the_orchestrator_rule_appears_only_for_a_delegating_agent(pe):
    # Platform-wide behaviour (the normalizer drops a sub-agent's call for every
    # deep agent), but an agent with no sub-agents cannot be in that situation,
    # so telling it describes a state it cannot reach.
    with_subs = pe.compose_system_prompt(
        "x", pe.PromptContext(has_conversation=True, has_subagents=True)
    )
    without = pe.compose_system_prompt("x", pe.PromptContext(has_conversation=True))

    assert "sub-agent" in with_subs
    assert "sub-agent" not in without


def test_the_platform_verbs_need_a_conversation(pe):
    # All three point into the conversation mounts and are not attached without
    # one, so describing them would be describing tools the run does not have.
    with_conv = pe.compose_system_prompt("x", pe.PromptContext(has_conversation=True))
    without = pe.compose_system_prompt("x", pe.PromptContext())

    for verb in ("view_image", "present_artifact", "render_chart"):
        assert verb in with_conv
        assert verb not in without


# ---------------------------------------------------------------------------
# Order
# ---------------------------------------------------------------------------
def test_the_sections_are_ordered_stable_first_volatile_last(pe, full):
    # The clock changes every minute; everything above it is fixed for the run.
    # Putting it earlier would invalidate the provider's prompt-prefix cache on
    # every single request.
    assert pe.describe_sections(full) == [
        "personalization",
        "filesystem",
        "capabilities",
        "memory",
        "temporal",
    ]

    out = pe.compose_system_prompt("x", full)
    assert out.index("## Your Workspace") < out.index("## Right Now")
    assert out.index("## Your Long-Term Memory") < out.index("## Right Now")


def test_an_inactive_section_is_absent_from_the_description(pe):
    assert pe.describe_sections(pe.PromptContext()) == []


# ---------------------------------------------------------------------------
# The clock
# ---------------------------------------------------------------------------
def test_the_current_date_is_stated(pe, full):
    out = pe.compose_system_prompt("x", full)
    assert "15 September 2026, 17:23 UTC" in out


def test_a_naive_datetime_is_read_as_utc(pe):
    out = pe.compose_system_prompt("x", pe.PromptContext(now=datetime(2026, 9, 15, 17, 23)))
    assert "17:23 UTC" in out


def test_a_run_without_a_clock_says_nothing_about_time(pe):
    assert "## Right Now" not in pe.compose_system_prompt("x", pe.PromptContext())


def test_the_stamp_has_no_seconds(pe):
    # Seconds would change the prompt on every call for no gain, defeating the
    # prefix cache the ordering above exists to protect.
    out = pe.compose_system_prompt(
        "x", pe.PromptContext(now=datetime(2026, 9, 15, 17, 23, 45, tzinfo=timezone.utc))
    )
    assert "17:23 UTC" in out
    assert "17:23:45" not in out
