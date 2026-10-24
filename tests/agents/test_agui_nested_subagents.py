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
import json

import pytest
from deepagents import create_deep_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage


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
