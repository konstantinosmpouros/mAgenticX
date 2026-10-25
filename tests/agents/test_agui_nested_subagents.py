"""A sub-agent that delegates in turn, end to end through the AG-UI normalizer.

deepagents does not give a declarative ``SubAgent`` the ``task`` tool, but a
``CompiledSubAgent`` whose runnable is itself a deep agent has one. That nested
run is driven here for real (scripted models, ``subgraphs=True``) so the test
sees the namespaces LangGraph actually emits — the grandchild's is two
``tools:<id>`` segments, and its ``task`` result lands in the parent's
namespace — and checks what the normalizer makes of them.
"""
from __future__ import annotations

import asyncio
import importlib
import json

import pytest
from deepagents import create_deep_agent
from deepagents.backends import StateBackend
from deepagents.middleware.subagents import SubAgentMiddleware
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command


class _Scripted(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def _task_call(call_id: str, subagent_type: str, description: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "id": call_id,
                "name": "task",
                "args": {"subagent_type": subagent_type, "description": description},
            }
        ],
    )


def _nested_agent():
    """main -> researcher (a compiled deep agent) -> checker."""
    checker_model = _Scripted(responses=[AIMessage(content="checked: prices ok")])
    researcher_model = _Scripted(
        responses=[_task_call("call-check", "checker", "Check the prices"), AIMessage(content="research done")]
    )
    main_model = _Scripted(
        responses=[_task_call("call-research", "researcher", "Find prices"), AIMessage(content="final answer")]
    )
    researcher = create_deep_agent(
        model=researcher_model,
        name="researcher",
        subagents=[
            {
                "name": "checker",
                "description": "Checks facts.",
                "system_prompt": "Check.",
                "model": checker_model,
                "tools": [],
            }
        ],
    )
    return create_deep_agent(
        model=main_model,
        subagents=[{"name": "researcher", "description": "Researches.", "runnable": researcher}],
    )


def _decode(frame) -> dict:
    text = frame.decode("utf-8") if isinstance(frame, (bytes, bytearray)) else str(frame)
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[len("data:"):].lstrip())
    raise AssertionError(f"no data line in frame: {text!r}")


@pytest.fixture(autouse=True)
def _clear_namespace_bindings(agents_service):
    stores = (
        agents_service.normalizer._THREAD_NAMESPACE_BINDINGS,
        agents_service.normalizer._THREAD_TASK_STARTED_AT,
        agents_service.normalizer._THREAD_TASK_COMPLETED,
    )
    for store in stores:
        store.clear()
    yield
    for store in stores:
        store.clear()


def _run_nested(agents_service) -> list[dict]:
    norm = agents_service.normalizer.AGUIStreamNormalizer(thread_id="nested-1")
    agent = _nested_agent()

    async def collect() -> list[dict]:
        events: list[dict] = []
        async for chunk in agent.astream(
            {"messages": [{"role": "user", "content": "go"}]},
            stream_mode=["messages", "updates"],
            subgraphs=True,
        ):
            events.extend(_decode(frame) for frame in norm.handle_chunk(chunk))
        return events

    return asyncio.run(collect())


def _wrapped(events: list[dict]) -> list[dict]:
    return [e["value"] for e in events if e.get("type") == "CUSTOM" and e.get("name") == "SUBAGENT_EVENT"]


def _inner_custom(envelope: dict, name: str) -> dict | None:
    inner = envelope["event"]
    return inner["value"] if inner.get("type") == "CUSTOM" and inner.get("name") == name else None


def test_grandchild_events_are_keyed_by_its_own_task_call(agents_service):
    events = _run_nested(agents_service)
    envelopes = _wrapped(events)

    checker = [env for env in envelopes if env["task_id"] == "call-check"]
    assert checker, "the nested sub-agent's events never surfaced"
    # One envelope deep, its namespace one level below its parent's.
    for env in checker:
        assert len(env["namespace"]) == 2
        assert all(part.startswith("tools:") for part in env["namespace"])
    researcher_ns = next(env["namespace"] for env in envelopes if env["task_id"] == "call-research")
    assert len(researcher_ns) == 1
    assert checker[0]["namespace"][0] == researcher_ns[0]
    # Its reply streams as its own text.
    deltas = "".join(
        str(env["event"].get("delta") or "")
        for env in checker
        if env["event"].get("type") in {"TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_CONTENT"}
    )
    assert "checked: prices ok" in deltas


def test_grandchild_task_call_arrives_inside_its_parents_stream(agents_service):
    envelopes = _wrapped(_run_nested(agents_service))

    nested_calls = [
        (env["task_id"], value)
        for env in envelopes
        if (value := _inner_custom(env, "TASK_SUBAGENT")) is not None
    ]
    assert nested_calls == [
        ("call-research", {"task_id": "call-check", "subagent_type": "checker", "description": "Check the prices"})
    ]


def test_nested_subagent_binds_to_its_callers_task_not_a_waiting_sibling(agents_service):
    """The orchestrator delegated twice; only the first has started when it
    delegates in turn. The nested sub-agent's namespace extends the first's, so
    it binds to the first's `task` call — not to the sibling call queued ahead."""
    norm = agents_service.normalizer.AGUIStreamNormalizer(thread_id="nested-2")
    marker = {"PatchToolCallsMiddleware.before_agent": None}
    norm.handle_chunk(
        ("updates", {"model": {"messages": [AIMessage(content="", tool_calls=[
            {"id": "call-a", "name": "task", "args": {"subagent_type": "researcher", "description": "A"}},
            {"id": "call-b", "name": "task", "args": {"subagent_type": "writer", "description": "B"}},
        ])]}})
    )
    norm.handle_chunk((("tools:a",), "updates", marker))
    norm.handle_chunk((("tools:a",), "updates", {"model": {"messages": [_task_call("call-a1", "checker", "A1")]}}))
    norm.handle_chunk((("tools:a", "tools:a1"), "updates", marker))
    norm.handle_chunk((("tools:b",), "updates", marker))

    assert norm._namespace_task_labels == {
        ("tools:a",): "call-a",
        ("tools:a", "tools:a1"): "call-a1",
        ("tools:b",): "call-b",
    }


def test_grandchild_completion_is_reported_inside_its_parents_stream(agents_service):
    events = _run_nested(agents_service)

    # The orchestrator's own sub-agent completes at top level ...
    top = [e["value"] for e in events if e.get("type") == "CUSTOM" and e.get("name") == "SUBAGENT_COMPLETED"]
    assert [value["task_id"] for value in top] == ["call-research"]
    # ... the nested one's `task` result lands in the researcher's namespace, so
    # its SUBAGENT_COMPLETED arrives wrapped in the researcher's envelope — with
    # the checker's own two-segment namespace so the UI can match either id.
    nested = [
        (env["task_id"], value)
        for env in _wrapped(events)
        if (value := _inner_custom(env, "SUBAGENT_COMPLETED")) is not None
    ]
    assert [(task_id, value["task_id"], value["status"]) for task_id, value in nested] == [
        ("call-research", "call-check", "completed")
    ]
    assert len(nested[0][1]["namespace"]) == 2
    assert isinstance(nested[0][1]["ended_at"], int)


# --------------------------------------------------------------------------
# Binding through the "tasks" stream: parallel siblings, and a /resume.
#
# Here the researcher is a declarative sub-agent whose own `middleware` carries
# a `SubAgentMiddleware` (how a declarative spec delegates in turn), and it
# starts two sub-agents from one model turn. Their chunks interleave, so call
# order cannot say which namespace is which; the "tasks" stream can.
# --------------------------------------------------------------------------


@tool
async def _slow_lookup(claim: str) -> str:
    """Look a claim up."""
    await asyncio.sleep(0.05)
    return f"{claim}: confirmed"


class _SlowScripted(_Scripted):
    """Answers a moment late, so a sibling started after it speaks first."""

    async def _agenerate(self, *args, **kwargs):
        await asyncio.sleep(0.05)
        return await super()._agenerate(*args, **kwargs)


def _parallel_agent(*, gated: bool = False):
    """main -> researcher -> (checker, citer) in parallel. The checker is
    called first but speaks last. ``gated``: the researcher's `task` calls and
    the checker's own tool wait for an approval."""
    checker = {
        "name": "checker",
        "description": "Checks facts.",
        "system_prompt": "Check.",
        "model": _SlowScripted(responses=[
            AIMessage(content="", tool_calls=[{"id": "call-lookup", "name": "_slow_lookup", "args": {"claim": "330 m"}}]),
            AIMessage(content="checker: true"),
        ]),
        "tools": [_slow_lookup],
        **({"interrupt_on": {"_slow_lookup": True}} if gated else {}),
    }
    citer = {
        "name": "citer",
        "description": "Formats citations.",
        "system_prompt": "Cite.",
        "model": _Scripted(responses=[AIMessage(content="citer: SETE 2022")]),
        "tools": [],
    }
    both = AIMessage(content="", tool_calls=[
        {"id": "call-check", "name": "task", "args": {"subagent_type": "checker", "description": "Check 330 m"}},
        {"id": "call-cite", "name": "task", "args": {"subagent_type": "citer", "description": "Cite it"}},
    ])
    researcher = {
        "name": "researcher",
        "description": "Researches.",
        "system_prompt": "Research.",
        "model": _Scripted(responses=[both, AIMessage(content="research done")]),
        "tools": [],
        "middleware": [SubAgentMiddleware(backend=StateBackend, subagents=[checker, citer])],
        **({"interrupt_on": {"task": True}} if gated else {}),
    }
    main_model = _Scripted(
        responses=[_task_call("call-research", "researcher", "Find it"), AIMessage(content="final answer")]
    )
    return create_deep_agent(model=main_model, subagents=[researcher], checkpointer=MemorySaver())


def _deep_agent_modes() -> list[str]:
    return list(importlib.import_module("harness.abstractions.deep_agent").DeepAgent.stream_mode)


async def _stream(agent, norm, stream_input, config) -> list[dict]:
    events: list[dict] = []
    async for chunk in agent.astream(stream_input, config=config, stream_mode=_deep_agent_modes(), subgraphs=True):
        events.extend(_decode(frame) for frame in norm.handle_chunk(chunk))
    return events


def _text_by_task(envelopes: list[dict]) -> dict[str, str]:
    text: dict[str, str] = {}
    for env in envelopes:
        if env["event"].get("type") in {"TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_CONTENT"}:
            text[env["task_id"]] = text.get(env["task_id"], "") + str(env["event"].get("delta") or "")
    return text


def test_the_deep_agent_streams_tasks_for_exact_binding():
    assert "tasks" in _deep_agent_modes()


def test_parallel_nested_siblings_each_keep_their_own_events(agents_service):
    norm = agents_service.normalizer.AGUIStreamNormalizer(thread_id="parallel-1")
    config = {"configurable": {"thread_id": "parallel-1"}}
    events = asyncio.run(_stream(_parallel_agent(), norm, {"messages": [{"role": "user", "content": "go"}]}, config))
    envelopes = _wrapped(events)

    assert _text_by_task(envelopes) == {
        "call-research": "research done",
        "call-check": "checker: true",
        "call-cite": "citer: SETE 2022",
    }
    # The checker's own tool is its, and each sibling has its own namespace.
    lookup = [env for env in envelopes if env["event"].get("toolCallId") == "call-lookup"]
    assert lookup and {env["task_id"] for env in lookup} == {"call-check"}
    namespaces = {env["task_id"]: tuple(env["namespace"]) for env in envelopes}
    assert namespaces["call-check"] != namespaces["call-cite"]
    assert namespaces["call-check"][:1] == namespaces["call-cite"][:1] == namespaces["call-research"]
    # Each completion names the namespace that really ran.
    completed = {
        value["task_id"]: tuple(value["namespace"])
        for env in envelopes
        if (value := _inner_custom(env, "SUBAGENT_COMPLETED")) is not None
    }
    assert completed == {"call-check": namespaces["call-check"], "call-cite": namespaces["call-cite"]}


def test_a_tool_call_wrapped_with_its_context_binds_too(agents_service):
    """`create_agent` may hand the tool node the call wrapped with its state."""
    norm = agents_service.normalizer.AGUIStreamNormalizer(thread_id="wrapped-1")
    norm.handle_chunk(
        ("updates", {"model": {"messages": [AIMessage(content="", tool_calls=[
            {"id": "call-a", "name": "task", "args": {"subagent_type": "researcher", "description": "A"}},
            {"id": "call-b", "name": "task", "args": {"subagent_type": "writer", "description": "B"}},
        ])]}})
    )
    call_b = {"id": "call-b", "name": "task", "args": {"subagent_type": "writer", "description": "B"}}
    norm.handle_chunk(((), "tasks", {"id": "nb", "name": "tools", "input": {"__type": "tool_call_with_context", "tool_call": call_b, "state": {}}, "triggers": []}))
    # call-b's sub-agent speaks first; call-a is queued ahead of it but is not its.
    norm.handle_chunk((("tools:nb",), "updates", {"model": {"messages": [AIMessage(content="b says")]}}))
    norm.handle_chunk((("tools:na",), "updates", {"model": {"messages": [AIMessage(content="a says")]}}))

    assert norm._namespace_task_labels == {("tools:nb",): "call-b", ("tools:na",): "call-a"}


def test_a_nested_task_across_a_resume_completes_once_under_its_own_call(agents_service):
    """The run pauses twice: on the researcher's `task` calls, then inside the
    checker on its own tool, after the citer has returned. Each /resume stream
    runs through a fresh normalizer (seeded from the orchestrator's state, as
    the router does) that never saw the nested calls announced, yet their
    sub-agents keep their call ids and each completes exactly once."""
    agent = _parallel_agent(gated=True)
    config = {"configurable": {"thread_id": "resume-1"}}
    legs: list[list[dict]] = []

    async def run() -> None:
        stream_input: object = {"messages": [{"role": "user", "content": "go"}]}
        for _ in range(4):
            norm = agents_service.normalizer.AGUIStreamNormalizer(thread_id="resume-run-1")
            if legs:
                norm.seed_pending_tasks((await agent.aget_state(config)).values.get("messages"))
            legs.append(await _stream(agent, norm, stream_input, config))
            snapshot = await agent.aget_state(config)
            if not snapshot.interrupts:
                return
            count = len(snapshot.interrupts[0].value.get("action_requests") or [1])
            stream_input = Command(resume={"decisions": [{"type": "approve"}] * count})

    asyncio.run(run())

    assert len(legs) == 3
    assert _text_by_task(_wrapped(legs[1])) == {"call-cite": "citer: SETE 2022"}
    assert _text_by_task(_wrapped(legs[2])) == {"call-research": "research done", "call-check": "checker: true"}
    lookup = [env for env in _wrapped(legs[2]) if env["event"].get("toolCallId") == "call-lookup"]
    assert lookup and {env["task_id"] for env in lookup} == {"call-check"}
    all_completions = [
        value["task_id"]
        for leg in legs
        for env in _wrapped(leg)
        if (value := _inner_custom(env, "SUBAGENT_COMPLETED")) is not None
    ]
    assert sorted(all_completions) == ["call-check", "call-cite"]
