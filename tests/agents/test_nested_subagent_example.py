"""The nested example agent, end to end through the real build and stream path.

``fixtures/agents/nested-research-demo`` is a YAML agent (test-only, never
seeded): main → researcher → fact-checker. It is loaded like any platform
agent, built by ``YamlDeepAgent`` → ``build_deep_agent``, and streamed through
``BaseAgent.astream`` and the AG-UI normalizer, with scripted models. Each
approval resumes through a FRESH agent instance seeded the way the /resume
route seeds it — so this is the run the chat would see:

* the `task` gate (a builtin default) pauses the main agent's delegation AND
  the researcher's own — the run's gates apply one level down;
* every level's model calls carry the usage stamp and its tool calls the tool
  stamp — the platform middleware runs at depth 2;
* the fact-checker cannot call ``ask_user`` — the tool is not in its tool set;
* each sub-agent's events, its nested `task` call and its completion are keyed
  to the right `task` call.

``record_example_run`` is also what recorded the fixture the UI tests and the
screenshots use (``fixtures/nested_subagents/example_scripted_run.json``).
"""
from __future__ import annotations

import asyncio
import importlib
import itertools
import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from deepagents.backends import StateBackend
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from pydantic import Field

EXAMPLE_DIR = Path(__file__).resolve().parent / "fixtures" / "agents" / "nested-research-demo"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "nested_subagents" / "example_scripted_run.json"
QUESTION = "How tall is the Eiffel Tower? Please verify it."


# ---------------------------------------------------------------------------
# Scripted models: one model for every agent, answering by the role its system
# prompt opens with.
# ---------------------------------------------------------------------------
def _task(call_id: str, subagent: str, description: str) -> dict:
    return {"id": call_id, "name": "task", "args": {"subagent_type": subagent, "description": description}}


SCRIPTS: dict[str, list[tuple[str, list[dict]]]] = {
    "You are the demo orchestrator": [
        ("", [_task("call-research", "researcher", "How tall is the Eiffel Tower? Verify the height.")]),
        ("The Eiffel Tower is 330 m tall — the researcher's fact-checker confirmed it.", []),
    ],
    "You are the demo researcher": [
        ("", [{"id": "call-research-ls", "name": "ls", "args": {"path": "/"}}]),
        ("", [_task("call-check", "fact-checker", "Verify: the Eiffel Tower is 330 m tall.")]),
        ("Report: the Eiffel Tower is 330 m tall (2022 survey); the fact-checker confirmed it.", []),
    ],
    "You are the demo fact-checker": [
        # Not in its tool set: the tool node refuses the call.
        ("", [{"id": "call-check-ask", "name": "ask_user", "args": {"questions": []}}]),
        ("", [{"id": "call-check-ls", "name": "ls", "args": {"path": "/"}}]),
        ("TRUE — the Eiffel Tower is 330 m tall including its antennas.", []),
    ],
}


class ScriptedModel(FakeMessagesListChatModel):
    """Every agent's model. Picks the next scripted reply of the agent whose
    system prompt it is called with."""

    responses: list = Field(default_factory=list)
    model_name: str = "scripted-demo"
    cursor: dict = Field(default_factory=dict)

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        system = messages[0].text if messages else ""
        role = next((r for r in SCRIPTS if system.startswith(r)), None)
        if role is None:
            raise AssertionError(f"no script for system prompt: {system[:80]!r}")
        index = self.cursor.get(role, 0)
        self.cursor[role] = index + 1
        text, calls = SCRIPTS[role][index]
        n = next(_ids)
        message = AIMessage(
            id=f"msg-{role.rsplit(' ', 1)[-1]}-{n}",
            content=text,
            tool_calls=[{**call, "type": "tool_call"} for call in calls],
            usage_metadata={"input_tokens": 100 * n, "output_tokens": 10 * n, "total_tokens": 110 * n},
            response_metadata={"model_name": "scripted-demo"},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _agenerate(self, *args, **kwargs):
        await asyncio.sleep(0.02)
        return self._generate(*args, **kwargs)


_ids = itertools.count(1)


# ---------------------------------------------------------------------------
# The run, as the chat makes it
# ---------------------------------------------------------------------------
def load_spec(agents_service) -> Any:
    spec_module = importlib.import_module("harness.abstractions.agent_spec")
    raw = yaml.safe_load((EXAMPLE_DIR / "agent.yaml").read_text(encoding="utf-8"))
    return spec_module.AgentSpec.model_validate(raw)


def make_agent(agents_service, spec, *, checkpointer, run_id: str, thread_id: str) -> Any:
    """A fresh agent instance per stream, as each /stream and /resume request
    builds one. Only the workspace is swapped for in-memory state: the real
    one is database-backed."""
    yaml_module = importlib.import_module("harness.abstractions.yaml_agent")
    agent = yaml_module.YamlDeepAgent(
        spec,
        EXAMPLE_DIR,
        config={
            "context": {"user_id": "demo-user", "conversation_id": "demo-conv", "run_id": run_id, "use_memory": False},
            "run_config": {"configurable": {"thread_id": thread_id}, "recursion_limit": 200},
        },
    )
    agent.checkpointer = checkpointer
    agent._build_composite_backend = lambda: StateBackend()
    return agent


def _decode(frame: Any) -> dict:
    text = frame.decode("utf-8") if isinstance(frame, (bytes, bytearray)) else str(frame)
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[len("data:"):].lstrip())
    return {"type": "UNDECODABLE", "raw": text}


async def run_legs(agents_service, *, max_legs: int = 6) -> tuple[list[list[dict]], list[Any]]:
    """Stream the question, approving every pause on a new agent instance.
    Returns the AG-UI events of each stream and every raw chunk."""
    normalizer = importlib.import_module("harness.agui.normalizer")
    spec = load_spec(agents_service)
    checkpointer = MemorySaver()
    run_id, thread_id = "demo-run", "demo-thread"
    normalizer.release_namespace_bindings(run_id)
    legs: list[list[dict]] = []
    raw: list[Any] = []
    command: Command | None = None
    for _ in range(max_legs):
        agent = make_agent(agents_service, spec, checkpointer=checkpointer, run_id=run_id, thread_id=thread_id)
        if command is not None:
            await agent.ensure_built()
            snapshot = await agent.compiled.aget_state(agent.run_config)
            agent.agui_normalizer.seed_pending_tasks(snapshot.values.get("messages"))
        handle = agent.agui_normalizer.handle_chunk

        def spy(chunk, handle=handle):
            raw.append(chunk)
            return handle(chunk)

        agent.agui_normalizer.handle_chunk = spy
        events = [
            _decode(frame)
            async for frame in agent.astream({"messages": [{"role": "user", "content": QUESTION}]}, command=command)
        ]
        legs.append(events)
        snapshot = await agent.compiled.aget_state(agent.run_config)
        if not snapshot.interrupts:
            break
        requests = (snapshot.interrupts[0].value or {}).get("action_requests") or [None]
        command = Command(resume={"decisions": [{"type": "approve"}] * len(requests)})
    normalizer.release_namespace_bindings(run_id)
    return legs, raw


@pytest.fixture
def scripted(monkeypatch):
    """Every model the build resolves is the scripted one."""
    model = ScriptedModel(responses=[], cursor={})
    models = importlib.import_module("deepagents._models")
    monkeypatch.setattr(models, "init_chat_model", lambda *args, **kwargs: model)
    return model


def record_example_run(agents_service, path: Path = FIXTURE) -> dict:
    legs, _ = asyncio.run(run_legs(agents_service))
    fixture = {
        "description": (
            "The nested-research-demo example agent (tests/agents/fixtures/agents), scripted models, "
            "streamed through YamlDeepAgent/build_deep_agent/BaseAgent.astream and the AG-UI normalizer; "
            "one list of events per stream (each a fresh agent instance, approving the `task` gate in between)."
        ),
        "legs": legs,
    }
    path.write_text(json.dumps(fixture, indent=1, ensure_ascii=False), encoding="utf-8")
    return fixture


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def _custom(event: dict, name: str) -> dict | None:
    return event.get("value") if event.get("type") == "CUSTOM" and event.get("name") == name else None


def _envelopes(events: list[dict]) -> list[dict]:
    return [v for e in events if (v := _custom(e, "SUBAGENT_EVENT")) is not None]


@pytest.fixture
def run(agents_service, scripted):
    return asyncio.run(run_legs(agents_service))


def test_the_task_gate_pauses_both_levels_of_delegation(run):
    legs, _ = run
    assert len(legs) == 3
    first = [_custom(e, "HITL_INTERRUPT") for e in legs[0] if _custom(e, "HITL_INTERRUPT")]
    assert [a["name"] for a in first[0]["interrupt"]["value"]["action_requests"]] == ["task"]
    # The second pause is the researcher's own `task` call, raised inside its stream.
    nested = [
        (env["task_id"], inner["value"])
        for env in _envelopes(legs[1])
        if (inner := env["event"]).get("name") == "HITL_INTERRUPT"
    ]
    assert nested and nested[0][0] == "call-research"
    assert nested[0][1]["interrupt"]["value"]["action_requests"][0]["args"]["subagent_type"] == "fact-checker"


def test_each_level_is_keyed_to_its_task_call(run):
    legs, _ = run
    events = [e for leg in legs for e in leg]
    envelopes = _envelopes(events)
    by_task: dict[str, list[dict]] = {}
    for env in envelopes:
        by_task.setdefault(env["task_id"], []).append(env)

    assert set(by_task) == {"call-research", "call-check"}
    assert {len(env["namespace"]) for env in by_task["call-research"]} == {1}
    assert {len(env["namespace"]) for env in by_task["call-check"]} == {2}
    nested_calls = [
        inner["value"]["task_id"] for env in by_task["call-research"]
        if (inner := env["event"]).get("name") == "TASK_SUBAGENT"
    ]
    assert set(nested_calls) == {"call-check"}
    tools = sorted(
        (env["task_id"], env["event"]["toolCallId"], env["event"]["toolCallName"])
        for env in envelopes if env["event"].get("type") == "TOOL_CALL_START"
    )
    assert tools == [("call-check", "call-check-ls", "ls"), ("call-research", "call-research-ls", "ls")]
    completed_inside = [
        (env["task_id"], inner["value"]["task_id"])
        for env in envelopes if (inner := env["event"]).get("name") == "SUBAGENT_COMPLETED"
    ]
    assert completed_inside == [("call-research", "call-check")]
    top = [v["task_id"] for e in events if (v := _custom(e, "SUBAGENT_COMPLETED"))]
    assert top == ["call-research"]
    answer = "".join(e.get("delta") or "" for e in events if e.get("type") in {"TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_CONTENT"})
    assert answer.startswith("The Eiffel Tower is 330 m tall")


def test_the_platform_middleware_runs_at_depth(run):
    legs, _ = run
    envelopes = _envelopes([e for leg in legs for e in leg])
    usage = {
        env["task_id"]: inner["value"]
        for env in envelopes if (inner := env["event"]).get("name") == "TOKEN_USAGE"
    }
    tool_usage = {
        env["task_id"]: inner["value"]
        for env in envelopes if (inner := env["event"]).get("name") == "TOOL_USAGE"
    }
    # UsageMetricsMiddleware stamped the fact-checker's calls (latency, model).
    assert set(usage) == {"call-research", "call-check"}
    assert isinstance(usage["call-check"].get("latency_ms"), int)
    # ToolMetricsMiddleware stamped its `ls`.
    assert tool_usage["call-check"]["tool_name"] == "ls"
    assert tool_usage["call-research"]["tool_name"] == "ls"


def test_ask_user_is_not_a_tool_of_a_nested_subagent(run):
    _, raw = run
    refusals = [
        payload for chunk in raw
        for payload in [chunk[2][0] if chunk[1] == "messages" else None]
        if isinstance(payload, ToolMessage) and payload.tool_call_id == "call-check-ask"
    ]
    assert refusals, "the fact-checker's ask_user call never came back"
    assert all(m.status == "error" and "ask_user is not a valid tool" in str(m.content) for m in refusals)
