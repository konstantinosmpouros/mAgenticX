"""``ask_user``: clarifying questions as a human-in-the-loop pause.

What is pinned here:

* the interrupt value is the contract with the UI — ``{"type": "ask_user",
  "questions": [{"id": "q1", ...}]}`` — and the resume value comes back as the
  tool's result text, through a real deep agent and checkpointer;
* a sub-agent's call is refused instead of pausing (deepagents hands the
  general-purpose sub-agent the parent's whole tool list);
* the tool exists only for an interactive run with a conversation, is never
  approval-gated, and is never listed for an explicit sub-agent tool subset;
* the resume value is validated (unknown ids, malformed answers).
"""
from __future__ import annotations

import asyncio
import importlib
from types import SimpleNamespace
from typing import ClassVar

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage


@pytest.fixture
def ask_user(agents_service):
    return importlib.import_module("harness.tools.ask_user.tool")


@pytest.fixture
def registry(agents_service):
    return importlib.import_module("harness.tools.registry")


QUESTIONS = [
    {"question": "Which period?", "options": ["Q3 2025", "Q4 2025"]},
    {"question": "Which regions?", "options": ["North", "South", "East"], "multiple": True},
    {"question": "Anything to leave out?"},
]


class _Scripted(FakeMessagesListChatModel):
    """Replays scripted replies and records what the model was shown."""

    seen: ClassVar[list] = []

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, *args, **kwargs):
        type(self).seen.append(list(messages))
        return super()._generate(messages, *args, **kwargs)


def _call(call_id: str, name: str, args: dict) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"id": call_id, "name": name, "args": args}])


def _agent(ask_user, responses):
    from deepagents import create_deep_agent
    from langgraph.checkpoint.memory import MemorySaver

    _Scripted.seen = []
    return create_deep_agent(
        model=_Scripted(responses=responses),
        tools=[ask_user.build_ask_user_tool()],
        checkpointer=MemorySaver(),
    )


def _run(agent, payload, config):
    async def go():
        async for _ in agent.astream(payload, config, stream_mode=["updates"], subgraphs=True):
            pass
        return await agent.aget_state(config)

    return asyncio.run(go())


def _tool_result(call_id: str) -> str | None:
    for messages in _Scripted.seen:
        for message in messages:
            if message.type == "tool" and message.tool_call_id == call_id:
                return message.content
    return None


# ---------------------------------------------------------------------------
# Through a real deep agent: pause, resume, result
# ---------------------------------------------------------------------------
def test_the_call_pauses_with_numbered_questions_and_the_answers_come_back(ask_user):
    from langgraph.types import Command

    agent = _agent(ask_user, [_call("ask-1", "ask_user", {"questions": QUESTIONS}), AIMessage(content="done")])
    config = {"configurable": {"thread_id": "ask-1"}}

    paused = _run(agent, {"messages": [{"role": "user", "content": "make me a report"}]}, config)
    assert len(paused.interrupts) == 1
    assert paused.interrupts[0].value == {
        "type": "ask_user",
        "questions": [
            {"id": "q1", "question": "Which period?", "options": ["Q3 2025", "Q4 2025"], "multiple": False},
            {"id": "q2", "question": "Which regions?", "options": ["North", "South", "East"], "multiple": True},
            {"id": "q3", "question": "Anything to leave out?", "options": [], "multiple": False},
        ],
    }

    resume = ask_user.resume_value(
        paused.interrupts[0].value,
        decision="approve",
        value={"answers": [{"id": "q1", "selected": ["Q4 2025"], "text": ""}, {"id": "q3", "selected": [], "text": "drafts"}]},
    )
    finished = _run(agent, Command(resume=resume), config)

    assert finished.interrupts == ()
    assert _tool_result("ask-1") == (
        "The user answered your questions:\n"
        "1. Which period?\n"
        "   → Q4 2025\n"
        "2. Which regions?\n"
        "   → (no answer)\n"
        "3. Anything to leave out?\n"
        "   → drafts\n"
        "Now do the work with these answers. Do not ask again: state any "
        "assumption you still need to make."
    )
    assert finished.values["messages"][-1].content == "done"


def test_a_skip_tells_the_model_to_carry_on_with_assumptions(ask_user):
    from langgraph.types import Command

    agent = _agent(ask_user, [_call("ask-2", "ask_user", {"questions": QUESTIONS[:1]}), AIMessage(content="done")])
    config = {"configurable": {"thread_id": "ask-2"}}
    paused = _run(agent, {"messages": [{"role": "user", "content": "go"}]}, config)

    resume = ask_user.resume_value(paused.interrupts[0].value, decision="reject", value={"answers": "ignored"})
    _run(agent, Command(resume=resume), config)

    assert _tool_result("ask-2") == ask_user.SKIPPED_REPLY


def test_a_sub_agent_is_refused_instead_of_pausing_the_run(ask_user):
    # The general-purpose sub-agent inherits the parent's tools, ask_user among them.
    agent = _agent(
        ask_user,
        [
            _call("task-1", "task", {"subagent_type": "general-purpose", "description": "look into it"}),
            _call("ask-sub", "ask_user", {"questions": QUESTIONS[:1]}),
            AIMessage(content="sub done"),
            AIMessage(content="final"),
        ],
    )
    config = {"configurable": {"thread_id": "ask-sub"}}
    state = _run(agent, {"messages": [{"role": "user", "content": "go"}]}, config)

    assert state.interrupts == ()
    assert _tool_result("ask-sub") == ask_user.SUBAGENT_REFUSAL
    assert state.values["messages"][-1].content == "final"


# ---------------------------------------------------------------------------
# The pieces
# ---------------------------------------------------------------------------
def test_the_result_joins_choices_and_free_text(ask_user):
    questions = ask_user.ask_user_payload(QUESTIONS)["questions"]
    reply = {
        "answers": [
            {"id": "q2", "selected": ["North", "East"], "text": "and the islands"},
            {"id": "q1", "selected": [], "text": ""},
        ],
        "skipped": False,
    }
    assert ask_user.format_reply(questions, reply).splitlines() == [
        "The user answered your questions:",
        "1. Which period?",
        "   → (no answer)",
        "2. Which regions?",
        "   → North, East; and the islands",
        "3. Anything to leave out?",
        "   → (no answer)",
        "Now do the work with these answers. Do not ask again: state any "
        "assumption you still need to make.",
    ]


@pytest.mark.parametrize(
    "namespace, nested",
    [
        ("tools:7f1c", False),  # a main-agent tool runs one `tools:` task deep
        ("tools:7f1c|tools:a90e", True),  # a sub-agent's, inside the `task` tool
        ("tools:7f1c|tools:a90e|tools:0b2d", True),  # a nested sub-agent's
        ("", False),
    ],
)
def test_a_sub_agent_is_recognised_from_the_checkpoint_namespace(ask_user, namespace, nested):
    assert ask_user.in_subagent({"configurable": {"checkpoint_ns": namespace}}) is nested
    assert ask_user.in_subagent({"metadata": {"langgraph_checkpoint_ns": namespace}}) is nested


def test_without_a_namespace_the_call_is_the_main_agents(ask_user):
    assert ask_user.in_subagent(None) is False
    assert ask_user.in_subagent({}) is False


def test_the_tool_refuses_when_invoked_inside_a_sub_agent(ask_user):
    tool = ask_user.build_ask_user_tool()
    result = asyncio.run(
        tool.ainvoke(
            {"questions": QUESTIONS[:1]},
            config={"configurable": {"checkpoint_ns": "tools:a|tools:b"}},
        )
    )
    assert result == ask_user.SUBAGENT_REFUSAL


@pytest.mark.parametrize(
    "args",
    [
        {"questions": []},
        {"questions": [*QUESTIONS, {"question": "A fourth?"}]},
        {"questions": [{"question": "x" * 301}]},
        {"questions": [{"question": "Pick", "options": [str(i) for i in range(7)]}]},
    ],
)
def test_the_schema_bounds_the_questions(ask_user, args):
    from pydantic import ValidationError

    schema = importlib.import_module("harness.tools.ask_user.schema")
    with pytest.raises(ValidationError):
        schema.AskUserInput.model_validate(args)


# ---------------------------------------------------------------------------
# The resume value
# ---------------------------------------------------------------------------
@pytest.fixture
def panel(ask_user):
    return ask_user.ask_user_payload(QUESTIONS)


def test_answers_are_kept_as_the_users_strings(ask_user, panel):
    value = {"answers": [{"id": "q2", "selected": [" North ", "Somewhere new"], "text": " ok "}]}
    assert ask_user.resume_value(panel, decision="approve", value=value) == {
        "answers": [{"id": "q2", "selected": ["North", "Somewhere new"], "text": "ok"}],
        "skipped": False,
    }


def test_missing_fields_read_as_empty(ask_user, panel):
    value = {"answers": [{"id": "q1"}, {"id": "q3", "selected": None, "text": None}]}
    assert ask_user.resume_value(panel, decision="approve", value=value)["answers"] == [
        {"id": "q1", "selected": [], "text": ""},
        {"id": "q3", "selected": [], "text": ""},
    ]


def test_reject_is_a_skip_whatever_the_value(ask_user, panel):
    assert ask_user.resume_value(panel, decision="reject", value=None) == {"answers": [], "skipped": True}


@pytest.mark.parametrize(
    "value",
    [
        None,
        "free text",
        {"answers": "q1"},
        {"answers": ["q1"]},
        {"answers": [{"id": "q9", "selected": []}]},
        {"answers": [{"id": "q1"}, {"id": "q1"}]},
        {"answers": [{"id": "q1", "selected": "Q3 2025"}]},
        {"answers": [{"id": "q1", "selected": [3]}]},
        {"answers": [{"id": "q1", "text": ["x"]}]},
    ],
)
def test_a_malformed_reply_is_refused(ask_user, panel, value):
    with pytest.raises(ValueError):
        ask_user.resume_value(panel, decision="approve", value=value)


# ---------------------------------------------------------------------------
# Who gets it
# ---------------------------------------------------------------------------
def _ctx(registry, **overrides):
    fields = {"user_id": "u1", "agent_slug": "omni", "conversation_id": "c1"} | overrides
    return registry.NativeToolContext(**fields)


def test_an_interactive_conversation_run_gets_it(registry):
    names = [tool.name for tool in registry.build_auto_attach_tools(_ctx(registry, use_memory=False))]
    assert "ask_user" in names


def test_a_non_interactive_run_does_not(registry):
    # A scheduled task's run: nobody would ever answer.
    assert registry.NATIVE_TOOLS["ask_user"].builder(_ctx(registry, interactive=False)) is None
    names = [t.name for t in registry.build_auto_attach_tools(_ctx(registry, use_memory=False, interactive=False))]
    assert "ask_user" not in names


def test_a_run_without_a_conversation_does_not(registry):
    assert registry.NATIVE_TOOLS["ask_user"].builder(_ctx(registry, conversation_id=None)) is None


def test_it_is_a_builtin_that_can_never_be_gated(agents_service):
    builtins_mod = importlib.import_module("harness.tools.builtins")
    gates = importlib.import_module("harness.tools.gates")

    entry = builtins_mod.BUILTIN_BY_NAME["ask_user"]
    assert entry.gateable is False and entry.hitl_default is False and entry.locked is False
    assert entry.availability is builtins_mod.Availability.CONVERSATION
    assert "ask_user" in builtins_mod.ungateable_tools()

    # Every layer that can set a gate tries to, and none of them sticks.
    resolved = gates.resolve_interrupt_on(
        [], own_gates={"ask_user": True}, approvals={"ask_user": True}, agent_slug="omni"
    )
    assert "ask_user" not in resolved
    assert resolved["execute"] is True  # the locked gate is untouched


def test_the_agents_tab_offers_no_approval_switch_for_it(agents_service):
    agent_tools = importlib.import_module("utils.agent_tools")
    rows = {
        row.name: row
        for row in agent_tools._builtin_rows({"ask_user", "execute"}, use_memory=True, search_past_convs=False)
    }
    assert rows["ask_user"].approval is False
    assert rows["ask_user"].approvalLocked is True
    assert rows["execute"].approval is True and rows["execute"].approvalLocked is True


def test_an_explicit_sub_agent_subset_never_carries_it(agents_service, monkeypatch):
    spec_module = importlib.import_module("harness.abstractions.agent_spec")
    yaml_module = importlib.import_module("harness.abstractions.yaml_agent")
    natives = [{"native": "ask_user"}, {"native": "render_chart"}]
    spec = spec_module.AgentSpec.model_validate(
        {
            "id": "research-bot-v1",
            "slug": "research-bot",
            "name": "Research Bot",
            "version": "1.0.0",
            "type": "deep_agent",
            "prompt": "You research things.",
            "model": {"main": "openai:gpt-4o"},
            "tools": natives,
            "subagents": [{"name": "writer", "description": "Writes", "prompt": "Write.", "tools": natives}],
        }
    )
    agent = yaml_module.YamlDeepAgent.__new__(yaml_module.YamlDeepAgent)
    agent._spec = spec
    agent._source_dir = None
    agent._owner_user_id = None
    agent._definition_files = {}
    agent.context = {"user_id": "u1", "conversation_id": "c1"}
    agent.use_memory = False
    agent.name = "research-bot"
    agent.tools = []
    agent._conversation_files = SimpleNamespace()

    subs = {sa["name"]: sa for sa in agent.register_subagents()}
    assert [tool.name for tool in subs["writer"]["tools"]] == ["render_chart"]


# ---------------------------------------------------------------------------
# The deep agent wires the gate from the run context
# ---------------------------------------------------------------------------
def _deep_agent(agents_service, context):
    deep_agent = importlib.import_module("harness.abstractions.deep_agent")
    personalization = importlib.import_module("harness.personalization")

    class Agent(deep_agent.DeepAgent):
        name = "stub-agent"
        agent_id = "Stub"
        label = "Stub"
        version = "1.0.0"

        def register_agent(self):  # pragma: no cover
            raise NotImplementedError

    agent = Agent.__new__(Agent)
    agent.context = context
    agent.use_memory = False
    agent.tools = []
    agent.personalization = personalization.parse_personalization({})
    agent._conversation_files = SimpleNamespace()
    return agent


@pytest.mark.parametrize("interactive, expected", [(None, True), (True, True), (False, False)])
def test_the_deep_agent_attaches_and_describes_it_from_the_interactive_flag(agents_service, interactive, expected):
    context = {"user_id": "u1", "conversation_id": "c1"}
    if interactive is not None:
        context["interactive"] = interactive
    agent = _deep_agent(agents_service, context)

    assert ("ask_user" in [tool.name for tool in agent._builtin_tools()]) is expected
    assert agent.prompt_context().has_ask_user is expected
