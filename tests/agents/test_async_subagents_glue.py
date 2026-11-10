"""Plan 41 glue on the agents side: events, gates, ask_user and prompts.

What is pinned here:

* the normalizer turns a ``start_async_task`` result into ``TASK_LAUNCHED`` and
  a task notification deepagents pulled into a running run into
  ``TASK_SETTLED_INLINE`` — the shapes the UI parses (plan 41 §14.4) — and a
  notification is never rendered as the user's text;
* ``start_async_task`` owns the delegation gate, and ``task`` /
  ``start_async_task`` are one gate under two names at every layer, so stored
  preferences (migrated to the new name) and stored definitions (still on the
  old one) gate whichever tool the run has;
* ``AgentSpec`` reads ``hitl.task`` as ``hitl.start_async_task``;
* an async task run is a sub-agent for ``ask_user`` (the ``async_task_id``
  context marker), though its namespace looks like a main agent's;
* the background-delegation guidance appears only when the run says so.
"""
from __future__ import annotations

import asyncio
import importlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar

import pytest
import yaml
from deepagents import create_deep_agent
from deepagents.middleware.async_subagents import _notification_message
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver

TASK_ID = "5b0c7f0e-1111-4222-8333-944455556666"
SEED_OMNI = (
    Path(__file__).resolve().parents[2]
    / "magenticx" / "agents" / "harness" / "agents_seed" / "omni-yaml-v1" / "agent.yaml"
)


class _Scripted(FakeMessagesListChatModel):
    """Replays scripted replies and records what the model was shown."""

    seen: ClassVar[list] = []

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, *args, **kwargs):
        type(self).seen.append(list(messages))
        return super()._generate(messages, *args, **kwargs)


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------
@pytest.fixture
def normalizer(agents_service):
    mod = agents_service.normalizer
    mod._RUNS.clear()
    yield mod
    mod._RUNS.clear()


@pytest.fixture
def gates(agents_service):
    return importlib.import_module("harness.tools.gates")


@pytest.fixture
def builtins(agents_service):
    return importlib.import_module("harness.tools.builtins")


@pytest.fixture
def agent_spec(agents_service):
    return importlib.import_module("harness.abstractions.agent_spec")


@pytest.fixture
def ask_user(agents_service):
    return importlib.import_module("harness.tools.ask_user.tool")


@pytest.fixture
def pe(agents_service):
    return importlib.import_module("harness.prompt_engineering")


@pytest.fixture
def caps(agents_service):
    return importlib.import_module("harness.prompt_engineering.prompts.capabilities_prompt")


def _decode(frame) -> dict:
    """The JSON payload of one AG-UI SSE frame."""
    text = frame.decode("utf-8") if isinstance(frame, (bytes, bytearray)) else str(frame)
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[len("data:"):].lstrip())
    raise AssertionError(f"no data line in frame: {text!r}")


def _custom(frames, name: str) -> list[dict]:
    """The values of every CUSTOM event called ``name``."""
    return [
        p["value"]
        for p in map(_decode, frames)
        if p.get("type") == "CUSTOM" and p.get("name") == name
    ]


def _kinds(frames) -> list[str]:
    """Each frame's CUSTOM name, or its type for a standard event."""
    out = []
    for p in map(_decode, frames):
        out.append(p["name"] if p.get("type") == "CUSTOM" else p["type"])
    return out


def _launch_call(call_id="call-1", subagent="researcher", description="Find the 2025 figures."):
    """The orchestrator's AI message calling ``start_async_task``."""
    return AIMessage(
        content="",
        tool_calls=[
            {
                "id": call_id,
                "name": "start_async_task",
                "args": {"subagent_type": subagent, "description": description},
            }
        ],
    )


def _launch_result(call_id="call-1", task_id=TASK_ID, **kwargs) -> ToolMessage:
    """``start_async_task``'s result, worded exactly as deepagents 0.7.34 words it."""
    return ToolMessage(
        content=f"Launched async subagent. task_id: {task_id}",
        tool_call_id=call_id,
        name="start_async_task",
        **kwargs,
    )


def _notification(status="success", task_id=TASK_ID, agent="researcher", run_id="run-9") -> dict:
    """A task notification exactly as deepagents' pull path builds it."""
    return _notification_message(
        {
            "task_id": task_id,
            "agent_name": agent,
            "status": status,
            "run_id": run_id,
            "result": [{"type": "text", "text": "The figures are attached."}],
        }
    )


# ---------------------------------------------------------------------------
# Normalizer: TASK_LAUNCHED
# ---------------------------------------------------------------------------
def test_a_launch_emits_task_launched_with_the_calls_type_and_description(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-launch")
    announced = norm.handle_chunk(("updates", {"model": {"messages": [_launch_call()]}}))
    # No tool card opens for the launch: the "Started task" block is its UI.
    assert announced == []

    out = norm.handle_chunk(("messages", _launch_result()))

    assert _kinds(out) == ["TASK_LAUNCHED"]
    assert _custom(out, "TASK_LAUNCHED") == [
        {"task_id": TASK_ID, "name": "researcher", "description": "Find the 2025 figures."}
    ]
    assert _decode(out[0])["namespace"] is None


def test_the_launch_result_is_announced_once_across_both_channels(normalizer):
    # The ToolMessage streams on "messages" and again inside the tools node's
    # "updates" payload; a resume stream may replay it too.
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-once")
    norm.handle_chunk(("updates", {"model": {"messages": [_launch_call()]}}))
    first = norm.handle_chunk(("messages", _launch_result()))
    again = norm.handle_chunk(("updates", {"tools": {"messages": [_launch_result()]}}))
    resumed = normalizer.AGUIStreamNormalizer(thread_id="t-once")
    replayed = resumed.handle_chunk(("messages", _launch_result()))

    assert len(_custom(first, "TASK_LAUNCHED")) == 1
    assert again == []
    assert replayed == []


def test_a_launch_approved_on_resume_still_carries_its_type_and_description(normalizer):
    # A gated `start_async_task`: the /resume normalizer never saw the call, and
    # is seeded from the paused checkpoint before the stream starts.
    resumed = normalizer.AGUIStreamNormalizer(thread_id="t-resume")
    resumed.seed_pending_tasks([HumanMessage(content="go"), _launch_call(description="Draft it.")])

    out = resumed.handle_chunk(("messages", _launch_result()))

    assert _custom(out, "TASK_LAUNCHED") == [
        {"task_id": TASK_ID, "name": "researcher", "description": "Draft it."}
    ]


def test_an_unseen_launch_is_recognised_by_tool_name(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-unseen")
    out = norm.handle_chunk(("messages", _launch_result(call_id="call-x")))
    assert _custom(out, "TASK_LAUNCHED") == [{"task_id": TASK_ID, "name": "", "description": ""}]


@pytest.mark.parametrize(
    "result",
    [
        ToolMessage(
            content="Unknown async subagent type `nope`. Available types: researcher",
            tool_call_id="call-1",
            name="start_async_task",
        ),
        ToolMessage(
            content="Too many active tasks.",
            tool_call_id="call-1",
            name="start_async_task",
            status="error",
        ),
    ],
)
def test_a_failed_launch_shows_as_an_errored_tool_call(normalizer, result):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-fail")
    norm.handle_chunk(("updates", {"model": {"messages": [_launch_call()]}}))

    out = norm.handle_chunk(("messages", result))

    assert _kinds(out) == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_RESULT", "TOOL_CALL_END"]
    payloads = [_decode(f) for f in out]
    assert payloads[0]["toolCallName"] == "start_async_task"
    assert json.loads(payloads[1]["delta"])["args"]["subagent_type"] == "researcher"
    assert payloads[2]["error"] is True


def test_the_other_task_tools_keep_an_ordinary_tool_card(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-check")
    call = AIMessage(
        content="",
        tool_calls=[{"id": "chk-1", "name": "check_async_task", "args": {"task_id": TASK_ID}}],
    )
    started = norm.handle_chunk(("updates", {"model": {"messages": [call]}}))
    ended = norm.handle_chunk(
        ("messages", ToolMessage(content='{"status": "running"}', tool_call_id="chk-1", name="check_async_task"))
    )

    assert _kinds(started) == ["TOOL_CALL_START", "TOOL_CALL_ARGS"]
    assert _kinds(ended) == ["TOOL_CALL_RESULT", "TOOL_CALL_END"]


def test_an_update_shows_the_tasks_live_card_in_this_answer(normalizer):
    # `update_async_task` continues (or clarifies) an existing task: the answer
    # that sent it shows that task's card ("Updated task"), not a bare tool row,
    # so the user sees the task working again where they asked for it.
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-update")
    call = AIMessage(
        content="",
        tool_calls=[{"id": "upd-1", "name": "update_async_task",
                     "args": {"task_id": TASK_ID, "message": "Carry on with the essay."}}],
    )
    started = norm.handle_chunk(("updates", {"model": {"messages": [call]}}))
    ended = norm.handle_chunk(("messages", ToolMessage(
        content=f"Updated async subagent. task_id: {TASK_ID}", tool_call_id="upd-1", name="update_async_task")))

    assert started == []
    assert _custom(ended, "TASK_LAUNCHED") == [
        {"task_id": TASK_ID, "name": "", "description": "Carry on with the essay.", "action": "update"}
    ]


def test_an_update_to_a_task_that_was_waiting_still_links_its_card(normalizer):
    # deepagents ends the sentence right after the id when it dropped a pending
    # human request: the id must not keep the full stop (the card would not
    # find its task and show a nameless "Sub Agent" with no status).
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-update-waiting")
    call = AIMessage(content="", tool_calls=[{"id": "upd-3", "name": "update_async_task",
                                              "args": {"task_id": TASK_ID, "message": "Go on."}}])
    norm.handle_chunk(("updates", {"model": {"messages": [call]}}))
    ended = norm.handle_chunk(("messages", ToolMessage(
        content=f"Updated async subagent. task_id: {TASK_ID}. It was waiting for a human; that request was dropped.",
        tool_call_id="upd-3", name="update_async_task")))

    assert [v["task_id"] for v in _custom(ended, "TASK_LAUNCHED")] == [TASK_ID]


def test_a_failed_update_stays_a_visible_errored_tool_call(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-update-fail")
    call = AIMessage(content="", tool_calls=[{"id": "upd-2", "name": "update_async_task",
                                              "args": {"task_id": "nope", "message": "m"}}])
    norm.handle_chunk(("updates", {"model": {"messages": [call]}}))
    ended = norm.handle_chunk(("messages", ToolMessage(
        content="Unknown task_id: nope", tool_call_id="upd-2", name="update_async_task", status="error")))

    assert "TASK_LAUNCHED" not in _kinds(ended)
    assert _kinds(ended)[:2] == ["TOOL_CALL_START", "TOOL_CALL_ARGS"]


def test_the_blocking_task_tool_still_emits_its_subagent_events(normalizer):
    # Until cut-over the old path stays: TASK_SUBAGENT on the call,
    # SUBAGENT_COMPLETED on the result, no TASK_LAUNCHED.
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-sync")
    call = AIMessage(
        content="",
        tool_calls=[{"id": "task-1", "name": "task", "args": {"subagent_type": "a", "description": "d"}}],
    )
    started = norm.handle_chunk(("updates", {"model": {"messages": [call]}}))
    ended = norm.handle_chunk(("messages", ToolMessage(content="done", tool_call_id="task-1", name="task")))

    assert _kinds(started) == ["TASK_SUBAGENT"]
    assert _kinds(ended) == ["SUBAGENT_COMPLETED"]


# ---------------------------------------------------------------------------
# Normalizer: TASK_SETTLED_INLINE
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "node",
    ["AsyncSubAgentMiddleware.before_model", "AsyncSubAgentMiddleware.after_model"],
)
def test_a_pulled_notification_emits_task_settled_inline(normalizer, node):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-pull")
    out = norm.handle_chunk(("updates", {node: {"messages": [_notification()], "async_tasks": {}}}))

    assert _kinds(out) == ["TASK_SETTLED_INLINE"]
    assert _custom(out, "TASK_SETTLED_INLINE") == [
        {"task_id": TASK_ID, "name": "researcher", "status": "success"}
    ]


@pytest.mark.parametrize(
    "status, shown",
    [("success", "success"), ("error", "error"), ("timeout", "error"), ("cancelled", "cancelled")],
)
def test_settled_statuses_map_onto_the_task_status_vocabulary(normalizer, status, shown):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-status")
    out = norm.handle_chunk(
        ("updates", {"AsyncSubAgentMiddleware.before_model": {"messages": [_notification(status=status)]}})
    )
    assert [v["status"] for v in _custom(out, "TASK_SETTLED_INLINE")] == [shown]


def test_a_task_waiting_for_approval_is_not_announced_as_finished(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-wait")
    out = norm.handle_chunk(
        ("updates", {"AsyncSubAgentMiddleware.before_model": {"messages": [_notification(status="waiting")]}})
    )
    assert out == []


def test_the_deprecated_notification_key_is_read_too(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-legacy")
    legacy = HumanMessage(
        content="<task-notification>...</task-notification>",
        additional_kwargs={
            "deepagents_notification": {"task_id": "t-7", "agent_name": "writer", "status": "error"}
        },
    )
    out = norm.handle_chunk(("updates", {"AsyncSubAgentMiddleware.before_model": {"messages": [legacy]}}))
    assert _custom(out, "TASK_SETTLED_INLINE") == [{"task_id": "t-7", "name": "writer", "status": "error"}]


def test_a_notification_is_announced_once(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-dupe")
    chunk = ("updates", {"AsyncSubAgentMiddleware.before_model": {"messages": [_notification()]}})
    assert len(norm.handle_chunk(chunk)) == 1
    assert norm.handle_chunk(chunk) == []


def test_the_runs_own_relabelled_input_is_not_announced(normalizer):
    # A wake-up run's input notification, rewritten by before_agent because a
    # follow-up superseded it: the update records no task at that run, and the
    # bridge shows the wake-up's notice row itself.
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-input")
    rewritten = HumanMessage(id="msg-input", **{k: v for k, v in _notification().items() if k != "role"})
    out = norm.handle_chunk(
        ("updates", {"AsyncSubAgentMiddleware.before_agent": {"messages": [rewritten], "async_tasks": {}}})
    )
    assert out == []


def test_an_outcome_pulled_by_before_agent_is_announced(normalizer):
    # A wake-up run pulls a second task that settled at the same time. The
    # middleware node coerces it to a message with an id, and records the
    # task at the event's run in the same update.
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-agent")
    pulled = HumanMessage(id="msg-pulled", **{k: v for k, v in _notification().items() if k != "role"})
    record = {"task_id": TASK_ID, "run_id": "run-9", "status": "success"}
    out = norm.handle_chunk(
        ("updates", {"AsyncSubAgentMiddleware.before_agent": {"messages": [pulled], "async_tasks": {TASK_ID: record}}})
    )
    assert _custom(out, "TASK_SETTLED_INLINE") == [{"task_id": TASK_ID, "name": "researcher", "status": "success"}]


def test_a_notification_is_never_rendered_as_text(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-text")
    note = _notification()
    as_message = HumanMessage(content=note["content"], additional_kwargs=note["additional_kwargs"])

    streamed = norm.handle_chunk(("messages", as_message))
    pulled = norm.handle_chunk(("updates", {"AsyncSubAgentMiddleware.before_model": {"messages": [as_message]}}))

    assert streamed == []
    kinds = _kinds(pulled)
    assert kinds == ["TASK_SETTLED_INLINE"]
    assert not any(k.startswith("TEXT_MESSAGE") for k in kinds)


def test_a_plain_user_message_in_an_update_says_nothing(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-human")
    out = norm.handle_chunk(("updates", {"model": {"messages": [HumanMessage(content="hello")]}}))
    assert out == []


def test_text_then_a_pulled_result_keeps_the_text_stream_intact(normalizer):
    norm = normalizer.AGUIStreamNormalizer(thread_id="t-mixed")
    text = norm.handle_chunk(("messages", AIMessageChunk(content="Working on it.")))
    pulled = norm.handle_chunk(
        ("updates", {"AsyncSubAgentMiddleware.before_model": {"messages": [_notification()]}})
    )
    assert _kinds(text) == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK"]
    assert _kinds(pulled) == ["TASK_SETTLED_INLINE"]


# ---------------------------------------------------------------------------
# Gates: one delegation gate under two names
# ---------------------------------------------------------------------------
def _resolve(gates, *, own=None, approvals=None):
    return gates.resolve_interrupt_on(
        [], own_gates=own, approvals=approvals or {}, agent_slug="stub"
    )


def test_start_async_task_is_gated_by_default_and_the_follow_ups_are_not(gates):
    resolved = _resolve(gates)
    assert resolved["start_async_task"] is True
    assert resolved["task"] is True
    for name in ("check_async_task", "update_async_task", "cancel_async_task", "list_async_tasks"):
        assert name not in resolved


@pytest.mark.parametrize("key", ["task", "start_async_task"])
def test_a_user_clearing_either_name_clears_both(gates, key):
    resolved = _resolve(gates, approvals={key: False})
    assert "task" not in resolved
    assert "start_async_task" not in resolved


@pytest.mark.parametrize("key", ["task", "start_async_task"])
def test_an_agents_own_gate_under_either_name_gates_both(gates, key):
    resolved = _resolve(gates, own={key: False}, approvals={key: True})
    assert resolved["task"] is True
    assert resolved["start_async_task"] is True


@pytest.mark.parametrize("key", ["task", "start_async_task"])
def test_an_agent_clearing_either_name_clears_both(gates, key):
    resolved = _resolve(gates, own={key: False})
    assert not resolved.get("task")
    assert not resolved.get("start_async_task")


def test_a_migrated_preference_gates_the_blocking_task_while_async_is_off(gates):
    # The bridge rewrote the stored `task` preference as `start_async_task`;
    # the run still has only `task` until the flag flips.
    resolved = _resolve(gates, own={"task": False}, approvals={"start_async_task": True})
    assert resolved["task"] is True


def test_a_layer_stating_both_names_keeps_each(gates):
    resolved = _resolve(gates, approvals={"task": True, "start_async_task": False})
    assert resolved["task"] is True
    assert "start_async_task" not in resolved


def test_the_alias_never_reaches_execute(gates):
    assert _resolve(gates, approvals={"task": False, "execute": False})["execute"] is True


def test_with_gate_aliases_copies_only_missing_names(gates):
    assert gates.with_gate_aliases({"task": True}) == {"task": True, "start_async_task": True}
    assert gates.with_gate_aliases({"start_async_task": False}) == {
        "start_async_task": False,
        "task": False,
    }
    assert gates.with_gate_aliases(None) == {}


def test_the_async_task_tools_are_reserved_names(builtins):
    for name in (
        "start_async_task",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
    ):
        assert builtins.is_builtin(name)


def test_the_builder_lists_the_delegation_tools_of_the_mode_it_runs(builtins):
    off = {t["name"]: t for t in builtins.builtin_tool_catalog()}
    on = {t["name"]: t for t in builtins.builtin_tool_catalog(async_subagents=True)}

    assert "task" in off and "start_async_task" not in off
    assert "task" not in on
    assert on["start_async_task"]["hitlDefault"] is True
    for name in ("check_async_task", "update_async_task", "cancel_async_task", "list_async_tasks"):
        assert on[name]["hitlDefault"] is False


def test_a_runs_delegation_tool_follows_the_flag(builtins):
    def available(name, flag):
        present, reason = builtins.resolve_availability(
            builtins.BUILTIN_BY_NAME[name],
            use_memory=True,
            search_past_convs=True,
            has_conversation=True,
            sandbox_enabled=False,
            async_subagents=flag,
        )
        return present, reason

    assert available("task", False) == (True, None)
    assert available("start_async_task", True) == (True, None)
    assert available("task", True)[0] is False
    assert available("start_async_task", False)[0] is False
    assert available("start_async_task", False)[1]


# ---------------------------------------------------------------------------
# AgentSpec: hitl.task is a deprecated alias
# ---------------------------------------------------------------------------
def _spec(agent_spec, hitl):
    return agent_spec.AgentSpec(
        id="a-1",
        slug="demo",
        name="Demo",
        version="1",
        type="deep_agent",
        prompt="./AGENT.md",
        model={"main": "openai:gpt-4o"},
        hitl=hitl,
    )


def test_hitl_task_is_read_as_start_async_task(agent_spec):
    spec = _spec(agent_spec, {"write_file": True, "task": True})
    assert spec.hitl == {"write_file": True, "start_async_task": True}


def test_hitl_task_false_is_kept_as_a_cleared_gate(agent_spec):
    assert _spec(agent_spec, {"task": False}).hitl == {"start_async_task": False}


def test_the_new_key_wins_when_a_definition_states_both(agent_spec):
    spec = _spec(agent_spec, {"task": False, "start_async_task": True})
    assert spec.hitl == {"start_async_task": True}


def test_a_re_saved_definition_carries_only_the_new_key(agent_spec):
    dumped = _spec(agent_spec, {"task": True}).model_dump(mode="json")
    assert dumped["hitl"] == {"start_async_task": True}


def test_the_normalised_gate_still_gates_the_blocking_task(agent_spec, gates):
    spec = _spec(agent_spec, {"task": False})
    resolved = _resolve(gates, own=spec.hitl)
    assert not resolved.get("task")
    assert not resolved.get("start_async_task")


def test_the_seed_omni_definition_loads_with_the_new_key(agent_spec):
    spec = agent_spec.AgentSpec.model_validate(yaml.safe_load(SEED_OMNI.read_text(encoding="utf-8")))
    assert spec.hitl.get("start_async_task") is True
    assert "task" not in spec.hitl


# ---------------------------------------------------------------------------
# ask_user: an async task is a sub-agent
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "context, expected",
    [
        ({"async_task_id": TASK_ID}, True),
        (SimpleNamespace(async_task_id=TASK_ID), True),
        ({"async_task_id": ""}, False),
        ({"async_task_id": "   "}, False),
        ({"async_task_id": None}, False),
        ({"user_id": "u-1"}, False),
        (None, False),
    ],
)
def test_the_task_marker_is_read_from_the_run_context(ask_user, context, expected):
    assert ask_user.is_async_task_context(context) is expected


def test_a_top_level_task_run_is_a_sub_agent(ask_user):
    # One `tools:` segment: by namespace alone it would pass for the main agent.
    config = {
        "configurable": {
            "checkpoint_ns": "tools:7f1c",
            ask_user.CONFIG_KEY_RUNTIME: SimpleNamespace(context={"async_task_id": TASK_ID}),
        }
    }
    assert ask_user.in_subagent(config) is True
    assert ask_user.in_subagent({"configurable": {"checkpoint_ns": "tools:7f1c"}}) is False


def test_the_marker_on_the_agents_own_context_counts_too(ask_user):
    assert ask_user.in_subagent({}, context={"async_task_id": TASK_ID}) is True
    assert ask_user.in_subagent(None, context={"async_task_id": TASK_ID}) is True
    assert ask_user.in_subagent({}, context={"user_id": "u-1"}) is False


def test_a_tool_built_for_a_task_run_refuses(ask_user):
    tool = ask_user.build_ask_user_tool(context={"async_task_id": TASK_ID})
    result = asyncio.run(
        tool.ainvoke(
            {"questions": [{"question": "Which period?"}]},
            config={"configurable": {"checkpoint_ns": "tools:a"}},
        )
    )
    assert result == ask_user.SUBAGENT_REFUSAL


def test_a_task_run_refuses_through_a_real_deep_agent(ask_user):
    # The tool is built without the marker: only LangGraph's run context has it.
    _Scripted.seen = []
    agent = create_deep_agent(
        model=_Scripted(
            responses=[
                AIMessage(
                    content="",
                    tool_calls=[{"id": "ask-1", "name": "ask_user", "args": {"questions": [{"question": "Which?"}]}}],
                ),
                AIMessage(content="done"),
            ]
        ),
        tools=[ask_user.build_ask_user_tool()],
        checkpointer=MemorySaver(),
    )
    config = {"configurable": {"thread_id": TASK_ID}}

    async def go():
        async for _ in agent.astream(
            {"messages": [{"role": "user", "content": "go"}]},
            config,
            context={"async_task_id": TASK_ID},
            stream_mode=["updates"],
        ):
            pass
        return await agent.aget_state(config)

    state = asyncio.run(go())

    assert state.interrupts == ()
    results = [
        m.content for msgs in _Scripted.seen for m in msgs if m.type == "tool" and m.tool_call_id == "ask-1"
    ]
    assert results and results[0] == ask_user.SUBAGENT_REFUSAL


# ---------------------------------------------------------------------------
# Prompts: background delegation only when the run has it
# ---------------------------------------------------------------------------
def test_the_async_delegation_rules_appear_only_when_the_run_has_them(pe):
    on = pe.compose_system_prompt(
        "x", pe.PromptContext(has_conversation=True, has_subagents=True, async_subagents=True)
    )
    off = pe.compose_system_prompt("x", pe.PromptContext(has_conversation=True, has_subagents=True))

    for verb in ("start_async_task", "update_async_task", "cancel_async_task", "check_async_task"):
        assert f"`{verb}`" in on
        assert verb not in off
    assert "Do not poll" in on
    assert "keep talking with the user" in on


def test_resuming_a_task_goes_through_update_not_a_new_task(pe):
    # "Resume it" must continue the same task (same thread, its work so far),
    # never launch a duplicate.
    on = pe.compose_system_prompt(
        "x", pe.PromptContext(has_conversation=True, has_subagents=True, async_subagents=True)
    )
    assert "**resume, continue or restart**" in on
    assert "Never start a new task with `start_async_task` for work an existing task" in on
    nested = importlib.import_module("harness.prompt_engineering.prompts.capabilities_prompt")
    assert "resume or continue a task" in nested.DELEGATING_ASYNC_SUBAGENT_PROMPT



def test_the_async_rules_need_an_agent_that_can_delegate(pe):
    alone = pe.compose_system_prompt("x", pe.PromptContext(has_conversation=True, async_subagents=True))
    assert "start_async_task" not in alone


def test_a_delegating_sub_agent_gets_the_wording_of_its_mode(caps):
    blocking = caps.delegating_subagent_prompt("Base.")
    background = caps.delegating_subagent_prompt("Base.", async_subagents=True)

    assert blocking == f"Base.\n\n{caps.DELEGATING_SUBAGENT_PROMPT}"
    assert "wait for every result" in blocking
    assert background == f"Base.\n\n{caps.DELEGATING_ASYNC_SUBAGENT_PROMPT}"
    assert "`start_async_task`" in background
    assert "do not poll" in background
    assert "`task`" not in background


def test_the_tools_page_leaves_out_the_delegation_mode_it_does_not_run(builtins):
    # `task` is not "unavailable for this run" once sub-agents are async — no
    # run on the deployment can have it — so the agent's Tools page omits it.
    replaced = builtins.replaced_by_delegation_mode
    by_name = builtins.BUILTIN_BY_NAME
    assert replaced(by_name["task"], async_subagents=True) is True
    assert replaced(by_name["start_async_task"], async_subagents=True) is False
    assert replaced(by_name["task"], async_subagents=False) is False
    assert replaced(by_name["start_async_task"], async_subagents=False) is True
    assert replaced(by_name["write_file"], async_subagents=True) is False
