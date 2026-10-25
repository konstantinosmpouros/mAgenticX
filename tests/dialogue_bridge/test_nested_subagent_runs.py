"""Real nested sub-agent runs, folded by the run accumulator.

The fixtures in ``tests/agents/fixtures/nested_subagents/`` are the AG-UI
events of real deepagents runs piped through the agents service's normalizer
(main -> researcher -> fact-checker -> source-verifier, plus a
citation-formatter beside the fact-checker, started in parallel with it):

* ``fake_run.json`` — scripted models, one stream;
* ``openai_run.json`` — the same topology on a real model (gpt-4.1-mini);
* ``fake_hitl_legs.json`` — scripted, with the researcher's ``task`` calls and
  the fact-checker's tool gated: three streams, each through a fresh
  normalizer, as the bridge receives them across two approvals.

Pinned: every model call and tool call is booked once, under the sub-agent
that made it at whatever depth (named by the type its parent's ``task`` call
gave it); the stored log keeps the nested completions; the answer is the main
agent's text only.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from utils.inference_runs import InferenceRunRuntime
from utils.run_activity import count_run_activity

FIXTURES = Path(__file__).resolve().parents[1] / "agents" / "fixtures" / "nested_subagents"
SUBAGENT_TYPES = {"researcher", "fact-checker", "source-verifier", "citation-formatter"}
TOOLS_BY_AGENT = {"researcher": "web_search", "fact-checker": "lookup_fact", "source-verifier": "find_source"}


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _custom(event: dict, name: str) -> dict | None:
    return event.get("value") if event.get("type") == "CUSTOM" and event.get("name") == name else None


def _expected(events: list[dict]) -> tuple[dict[str, str], dict[str, set[str]], dict[str, set[str]], str]:
    """Read the log independently: task id -> type, the model calls (message
    ids) and tool calls each agent made, and the main agent's text."""
    types: dict[str, str] = {}
    calls: dict[str, set[str]] = {}
    tools: dict[str, set[str]] = {}
    answer = ""

    def note(owner: str, event: dict) -> None:
        if (usage := _custom(event, "TOKEN_USAGE")) is not None:
            calls.setdefault(owner, set()).add(str(usage["message_id"]))
        if (tool := _custom(event, "TOOL_USAGE")) is not None:
            tools.setdefault(owner, set()).add(f"{tool['tool_name']}:{tool['tool_call_id']}")
        if (task := _custom(event, "TASK_SUBAGENT")) is not None:
            types[task["task_id"]] = task["subagent_type"]

    for event in events:
        if (envelope := _custom(event, "SUBAGENT_EVENT")) is not None:
            note(envelope["task_id"], envelope["event"])
        else:
            note("main", event)
            if event.get("type") in {"TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_CONTENT"}:
                answer += str(event.get("delta") or "")
    by_type_calls = {("main" if k == "main" else types[k]): v for k, v in calls.items()}
    by_type_tools = {("main" if k == "main" else types[k]): v for k, v in tools.items()}
    return types, by_type_calls, by_type_tools, answer


def _fold(runtime: InferenceRunRuntime, events: list[dict]) -> None:
    for event in events:
        runtime.apply_event(event)


def _calls_by_agent(runtime: InferenceRunRuntime) -> dict[str, int]:
    out: dict[str, int] = {}
    for (scope, agent, _model), sums in runtime.usage_groups.items():
        out["main" if scope == "main" else agent] = out.get("main" if scope == "main" else agent, 0) + sums["calls"]
    return out


@pytest.mark.parametrize("fixture", ["fake_run.json", "openai_run.json"])
def test_each_call_is_booked_once_under_the_agent_that_made_it(fixture):
    events = _load(fixture)["events"]
    types, calls, tools, answer = _expected(events)
    assert set(types.values()) == SUBAGENT_TYPES

    runtime = InferenceRunRuntime()
    _fold(runtime, events)

    assert _calls_by_agent(runtime) == {agent: len(ids) for agent, ids in calls.items()}
    assert set(_calls_by_agent(runtime)) == {"main", *SUBAGENT_TYPES}
    tool_groups = {(scope, agent, tool): sums["calls"] for (scope, agent, tool), sums in runtime.tool_groups.items()}
    assert tool_groups == {("subagent", agent, tool): 1 for agent, tool in TOOLS_BY_AGENT.items()}
    assert {agent: len(ids) for agent, ids in tools.items()} == {agent: 1 for agent in TOOLS_BY_AGENT}
    # Totals are the per-agent sums; nothing counted twice.
    assert runtime.input_tokens == sum(sums["input_tokens"] for sums in runtime.usage_groups.values())
    # The context gauge is the main agent's latest call, never a sub-agent's.
    main_contexts = [
        usage["context_tokens"]
        for e in events
        if (usage := _custom(e, "TOKEN_USAGE")) is not None and isinstance(usage.get("context_tokens"), int)
    ]
    assert runtime.context.get("context_tokens") == (main_contexts[-1] if main_contexts else None)
    # The answer is the main agent's text alone.
    assert runtime.content == answer and answer


@pytest.mark.parametrize("fixture", ["fake_run.json", "openai_run.json"])
def test_the_stored_log_keeps_every_nested_completion_and_counts_like_the_ui(fixture):
    events = _load(fixture)["events"]
    types, calls, tools, _ = _expected(events)

    runtime = InferenceRunRuntime()
    _fold(runtime, events)

    completed: dict[str, list[str]] = {}
    for event in runtime.raw_events:
        if (value := _custom(event, "SUBAGENT_COMPLETED")) is not None:
            completed.setdefault("main", []).append(types[value["task_id"]])
        elif (envelope := _custom(event, "SUBAGENT_EVENT")) is not None and (
            value := _custom(envelope["event"], "SUBAGENT_COMPLETED")
        ) is not None:
            completed.setdefault(types[envelope["task_id"]], []).append(types[value["task_id"]])
            assert value["status"] == "completed"
            assert value["started_at"] <= value["ended_at"]
    # Each completion is reported by the agent whose `task` call returned.
    assert {k: sorted(v) for k, v in completed.items()} == {
        "main": ["researcher"],
        "researcher": ["citation-formatter", "fact-checker"],
        "fact-checker": ["source-verifier"],
    }
    activity = count_run_activity(runtime.raw_events)
    assert activity.model_calls == sum(len(ids) for ids in calls.values())
    assert activity.tool_calls == sum(len(ids) for ids in tools.values())


def test_a_run_paused_twice_books_each_call_once_and_settles_its_interrupts():
    legs = _load("fake_hitl_legs.json")["legs"]
    assert len(legs) == 3
    runtime = InferenceRunRuntime()
    for index, leg in enumerate(legs):
        _fold(runtime, leg)
        if index < len(legs) - 1:
            # Each pause is ONE interrupt, though it is delivered once per level
            # it bubbles through (wrapped per sub-agent and at top level).
            assert runtime.pending_interrupts == 1
            runtime.resolve_interrupt(runtime.pending_interrupt_ids[0])
    assert runtime.pending_interrupts == 0

    everything = [event for leg in legs for event in leg]
    _types, calls, _tools, answer = _expected(everything)
    # A resume replays the step it paused in (the researcher's TOKEN_USAGE and
    # TASK_SUBAGENTs come again): still one call each.
    assert _calls_by_agent(runtime) == {agent: len(ids) for agent, ids in calls.items()}
    assert runtime.content == answer and answer


@pytest.mark.parametrize("fixture", ["example_scripted_run.json", "example_openai_run.json"])
def test_the_example_agent_run_through_the_build_path_books_every_level(fixture):
    """The YAML example agent (main → researcher → fact-checker) built and
    streamed by the agents service itself, paused on the `task` gate at both
    levels of delegation and resumed on a fresh agent each time."""
    legs = _load(fixture)["legs"]
    runtime = InferenceRunRuntime()
    for index, leg in enumerate(legs):
        _fold(runtime, leg)
        if index < len(legs) - 1:
            assert runtime.pending_interrupts == 1
            runtime.resolve_interrupt(runtime.pending_interrupt_ids[0])
    assert runtime.pending_interrupts == 0

    everything = [event for leg in legs for event in leg]
    types, calls, tools, answer = _expected(everything)
    assert sorted(types.values()) == ["fact-checker", "researcher"]
    assert _calls_by_agent(runtime) == {agent: len(ids) for agent, ids in calls.items()}
    assert set(_calls_by_agent(runtime)) == {"main", "researcher", "fact-checker"}
    booked_tools: dict[str, int] = {}
    for (scope, agent, _tool), sums in runtime.tool_groups.items():
        key = "main" if scope == "main" else agent
        booked_tools[key] = booked_tools.get(key, 0) + sums["calls"]
    assert booked_tools == {agent: len(ids) for agent, ids in tools.items()}
    assert booked_tools["fact-checker"] >= 1
    assert runtime.content == answer and answer
