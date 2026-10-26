"""Parallel approvals: several interrupts pending at once, each answered by id.

The run the bug report describes: the orchestrator delegates to three
sub-agents in parallel and each one stops at its own approval gate, so the
checkpoint holds three interrupts at once. A decision must reach the interrupt
it was made for — whether the three are answered together (one resume,
``Command(resume={interrupt_id: value, ...})``), in part, or one at a time in
any order. A bare resume value would go to whichever paused task read it first.

The end-to-end tests build the real agent (``YamlDeepAgent`` → deepagents →
LangGraph, the ``nested-research-demo`` fixture with scripted models), resume
each leg on a fresh instance like the /resume route does, and build every
command with the route's own :func:`utils.hitl_resume.build_resume_command`.
The route tests check the request shapes on top of that.
"""
from __future__ import annotations

import asyncio
import importlib
import itertools
from typing import Any, ClassVar

import pytest
import yaml
from deepagents.backends import StateBackend
from fastapi import HTTPException
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from pydantic import Field

from test_main_skill_routes import _FakeInterrupt, _FakeResumeAgent, _resume_env
from test_nested_subagent_example import EXAMPLE_DIR, _decode

_ids = itertools.count(1)
CLAIMS = ("1", "2", "3")


# ---------------------------------------------------------------------------
# Scripted run: orchestrator → 3 researchers in parallel → each delegates to a
# fact-checker through the gated `task` tool, so three gates pause at once.
# ---------------------------------------------------------------------------
def _task(call_id: str, subagent: str, description: str) -> dict:
    return {"id": call_id, "name": "task", "args": {"subagent_type": subagent, "description": description}}


class ParallelModel(FakeMessagesListChatModel):
    """Answers by role and by how far that agent's own conversation got, so
    parallel instances of one sub-agent never share a script cursor."""

    responses: list = Field(default_factory=list)
    model_name: str = "scripted-parallel"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        system = messages[0].text if messages else ""
        steps = sum(1 for m in messages if isinstance(m, AIMessage))
        brief = next((m.text for m in messages[1:] if m.type == "human"), "")
        claim = brief.rsplit(" ", 1)[-1]
        if system.startswith("You are the demo orchestrator"):
            calls = [_task(f"call-r{k}", "researcher", f"Research claim {k}") for k in CLAIMS] if steps == 0 else []
            text = "" if steps == 0 else "All three claims were researched."
        elif system.startswith("You are the demo researcher"):
            calls = [_task(f"call-c{claim}", "fact-checker", f"Verify claim {claim}")] if steps == 0 else []
            text = "" if steps == 0 else f"Report {claim}"
        elif system.startswith("You are the demo fact-checker"):
            calls, text = [], f"TRUE claim {claim}"
        else:
            raise AssertionError(f"no script for system prompt: {system[:80]!r}")
        message = AIMessage(
            id=f"msg-parallel-{next(_ids)}",
            content=text,
            tool_calls=[{**call, "type": "tool_call"} for call in calls],
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _agenerate(self, *args, **kwargs):
        await asyncio.sleep(0.01)
        return self._generate(*args, **kwargs)


@pytest.fixture
def scripted(monkeypatch):
    model = ParallelModel(responses=[])
    monkeypatch.setattr(importlib.import_module("deepagents._models"), "init_chat_model", lambda *a, **k: model)
    return model


class _Run:
    """One conversation thread, resumed leg by leg on fresh agent instances."""

    def __init__(self, agents_service) -> None:
        self.schema = agents_service.schemas
        spec_module = importlib.import_module("harness.abstractions.agent_spec")
        raw = yaml.safe_load((EXAMPLE_DIR / "agent.yaml").read_text(encoding="utf-8"))
        self.spec = spec_module.AgentSpec.model_validate(raw)
        self.checkpointer = MemorySaver()
        self.logger = importlib.import_module("core.logging").get_logger("test.parallel_resume")
        self.emitted: list[list[str]] = []

    def _agent(self) -> Any:
        yaml_module = importlib.import_module("harness.abstractions.yaml_agent")
        agent = yaml_module.YamlDeepAgent(
            self.spec,
            EXAMPLE_DIR,
            config={
                "context": {"user_id": "u", "conversation_id": "c", "run_id": "parallel-run", "use_memory": False},
                "run_config": {"configurable": {"thread_id": "parallel-thread"}, "recursion_limit": 200},
            },
        )
        agent.checkpointer = self.checkpointer
        agent._build_composite_backend = lambda: StateBackend()
        return agent

    async def leg(self, command: Command | None) -> list[Any]:
        """Stream one leg; returns the interrupts the run is paused on after it."""
        agent = self._agent()
        if command is not None:
            await agent.ensure_built()
            snapshot = await agent.compiled.aget_state(agent.run_config)
            agent.agui_normalizer.seed_pending_tasks(snapshot.values.get("messages"))
        frames = [_decode(f) async for f in agent.astream({"messages": [{"role": "user", "content": "q"}]}, command=command)]
        self.emitted.append(sorted(_claims_of(_hitl_values(frames))))
        snapshot = await agent.compiled.aget_state(agent.run_config)
        self.state = snapshot.values
        return list(snapshot.interrupts or [])

    def command(self, **request: Any) -> Command:
        req = self.schema.AgentResumeRequest(**{"config": {}, "thread_id": "parallel-thread", "decision": "approve", **request})
        return importlib.import_module("utils.hitl_resume").build_resume_command(req, self.pending, self.logger)

    async def pause_on_three_gates(self) -> dict[str, str]:
        """Approve the orchestrator's three delegations; returns claim → interrupt id."""
        first = await self.leg(None)
        assert len(first) == 1 and len(first[0].value["action_requests"]) == 3
        self.pending = first
        self.pending = await self.leg(self.command(interrupt_id=first[0].id))
        ids = {_claim(i.value): i.id for i in self.pending}
        assert sorted(ids) == list(CLAIMS) and len(set(ids.values())) == 3
        return ids

    def tool_result(self, call_id: str) -> str:
        """What one of the orchestrator's `task` calls returned (a researcher's report)."""
        return next(str(m.content) for m in self.state["messages"] if m.type == "tool" and m.tool_call_id == call_id)


def _hitl_values(frames: list[dict]) -> list[dict]:
    out = []
    for frame in frames:
        if frame.get("type") != "CUSTOM":
            continue
        if frame.get("name") == "HITL_INTERRUPT":
            out.append(frame["value"])
        elif frame.get("name") == "SUBAGENT_EVENT":
            inner = (frame.get("value") or {}).get("event") or {}
            if inner.get("name") == "HITL_INTERRUPT":
                out.append(inner["value"])
    return out


def _claim(interrupt_value: dict) -> str:
    return str(interrupt_value["action_requests"][0]["args"].get("description", "")).rsplit(" ", 1)[-1]


def _claims_of(values: list[dict]) -> set[str]:
    return {_claim(v["interrupt"]["value"]) for v in values if len(v["interrupt"]["value"]["action_requests"]) == 1}


def _approve(interrupt_id: str) -> dict:
    return {"interrupt_id": interrupt_id, "decision": "approve"}


def _reject(interrupt_id: str, reason: str) -> dict:
    return {"interrupt_id": interrupt_id, "decision": "reject", "reason": reason}


# ---------------------------------------------------------------------------
# End to end through LangGraph
# ---------------------------------------------------------------------------
def test_three_parallel_approvals_apply_together_in_one_resume(agents_service, scripted):
    async def go():
        run = _Run(agents_service)
        ids = await run.pause_on_three_gates()
        command = run.command(resumes=[_approve(ids["2"]), _reject(ids["3"], "not claim 3"), _approve(ids["1"])])
        assert set(command.resume) == set(ids.values())
        assert await run.leg(command) == []
        # Every researcher reported: the two approved fact-checks ran, the
        # rejected one came back to its researcher as the rejection.
        assert [run.tool_result(f"call-r{k}") for k in CLAIMS] == ["Report 1", "Report 2", "Report 3"]
        assert run.state["messages"][-1].content == "All three claims were researched."

    asyncio.run(go())


def test_a_partial_batch_leaves_the_rest_pending_and_they_resume_later(agents_service, scripted):
    async def go():
        run = _Run(agents_service)
        ids = await run.pause_on_three_gates()
        run.pending = await run.leg(run.command(resumes=[_approve(ids["1"]), _approve(ids["3"])]))
        # The stream re-surfaces only the gate still waiting.
        assert run.emitted[-1] == ["2"]
        assert run.pending, "the run finished without claim 2's decision"
        assert await run.leg(run.command(**_approve(ids["2"]))) == []
        assert run.state["messages"][-1].content == "All three claims were researched."

    asyncio.run(go())


def test_one_at_a_time_each_decision_reaches_its_own_interrupt(agents_service, scripted, monkeypatch):
    # Reject claim 2 only, answering in the order 2, 1, 3: the rejection must
    # land on researcher 2's gate and nowhere else.
    verdicts: dict[str, str] = {}
    hitl = importlib.import_module("langchain.agents.middleware.human_in_the_loop")
    original = hitl.HumanInTheLoopMiddleware.after_model

    def spy(self, state, runtime):
        result = original(self, state, runtime)
        for message in (result or {}).get("messages", []):
            if message.type == "tool":
                verdicts[message.tool_call_id] = str(message.content)
        return result

    monkeypatch.setattr(hitl.HumanInTheLoopMiddleware, "after_model", spy)

    async def go():
        run = _Run(agents_service)
        ids = await run.pause_on_three_gates()
        run.pending = await run.leg(run.command(**_reject(ids["2"], "skip claim 2")))
        assert run.emitted[-1] == ["1", "3"]
        run.pending = await run.leg(run.command(**_approve(ids["1"])))
        assert run.emitted[-1] == ["3"]
        assert await run.leg(run.command(**_approve(ids["3"]))) == []

    asyncio.run(go())
    assert verdicts == {"call-c2": "skip claim 2"}


def test_a_decision_for_an_interrupt_that_is_not_pending_is_refused(agents_service, scripted):
    async def go():
        run = _Run(agents_service)
        await run.pause_on_three_gates()
        with pytest.raises(HTTPException) as refused:
            run.command(interrupt_id="0" * 32)
        assert refused.value.status_code == 409
        # The 409 says which ids are stale and which are still pending, so the
        # bridge can drop the stale decision and send the rest again.
        assert refused.value.detail["stale_interrupt_ids"] == ["0" * 32]
        assert sorted(refused.value.detail["pending_interrupt_ids"]) == sorted(i.id for i in run.pending)

    asyncio.run(go())


# ---------------------------------------------------------------------------
# Two levels down: main -> researcher -> three parallel fact-checkers, each
# paused on its own gate (`ls`), as the chat's General Purpose -> helpers run.
# ---------------------------------------------------------------------------
class NestedModel(FakeMessagesListChatModel):
    responses: list = Field(default_factory=list)
    model_name: str = "scripted-nested"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        system = messages[0].text if messages else ""
        steps = sum(1 for m in messages if isinstance(m, AIMessage))
        brief = next((m.text for m in messages[1:] if m.type == "human"), "")
        claim = brief.rsplit(" ", 1)[-1]
        if system.startswith("You are the demo orchestrator"):
            calls = [_task("call-research", "researcher", "Research all claims")] if steps == 0 else []
            text = "" if steps == 0 else "All claims researched."
        elif system.startswith("You are the demo researcher"):
            calls = [_task(f"call-c{k}", "fact-checker", f"Verify claim {k}") for k in CLAIMS] if steps == 0 else []
            text = "" if steps == 0 else "Report"
        elif system.startswith("You are the demo fact-checker"):
            calls = [{"id": f"call-ls{claim}", "name": "ls", "args": {"path": "/"}}] if steps == 0 else []
            text = "" if steps == 0 else f"TRUE claim {claim}"
        else:
            raise AssertionError(f"no script for system prompt: {system[:80]!r}")
        message = AIMessage(
            id=f"msg-nested-{next(_ids)}",
            content=text,
            tool_calls=[{**call, "type": "tool_call"} for call in calls],
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _agenerate(self, *args, **kwargs):
        await asyncio.sleep(0.01)
        return self._generate(*args, **kwargs)


@pytest.fixture
def nested_scripted(monkeypatch):
    model = NestedModel(responses=[])
    monkeypatch.setattr(importlib.import_module("deepagents._models"), "init_chat_model", lambda *a, **k: model)
    return model


@pytest.fixture
def tool_errors(monkeypatch):
    """Every tool failure the run turned into an error result, with its message."""
    errors: list[str] = []
    module = importlib.import_module("harness.middlewares.tool_error")
    original = module.ToolErrorMiddleware._error_message

    def spy(request, exc):
        errors.append(f"{request.tool_call.get('name')}: {type(exc).__name__}: {exc}")
        return original(request, exc)

    monkeypatch.setattr(module.ToolErrorMiddleware, "_error_message", staticmethod(spy))
    return errors


class _NestedRun(_Run):
    def __init__(self, agents_service) -> None:
        super().__init__(agents_service)
        # Every `ls` waits for approval (the `task` gate stays on by default).
        self.spec = self.spec.model_copy(update={"hitl": {"ls": True}})

    async def pause_on_three_nested_gates(self) -> dict[str, str]:
        """Approve the two `task` pauses, one at a time as the chat does, until
        the three fact-checkers wait on their gates; returns claim -> id."""
        self.pending = await self.leg(None)
        while len(self.pending) == 1:
            self.pending = await self.leg(self.command(interrupt_id=self.pending[0].id))
        ids = {}
        for interrupt in self.pending:
            assert interrupt.value["action_requests"][0]["name"] == "ls"
            ids[interrupt.id] = interrupt.id
        assert len(ids) == 3
        return ids


def test_a_nested_partial_resume_keeps_every_other_helper_alive(agents_service, nested_scripted, tool_errors):
    # The live failure: one helper's approval went out alone, a stale run-wide
    # answer from an earlier `task` approval reached another helper's gate
    # ("Number of human decisions (3) does not match number of hanging tool
    # calls (1)"), that helper died and its approval vanished; the next batch
    # then hit a 409 and the run failed.
    async def go():
        run = _NestedRun(agents_service)
        await run.pause_on_three_nested_gates()
        first, *rest = [i.id for i in run.pending]
        run.pending = await run.leg(run.command(**_approve(first)))
        assert sorted(i.id for i in run.pending) == sorted(rest), "a helper's approval vanished"
        run.pending = await run.leg(run.command(resumes=[_approve(i) for i in rest]))
        assert run.pending == []
        assert run.state["messages"][-1].content == "All claims researched."

    asyncio.run(go())
    assert tool_errors == []


def test_nested_helpers_answered_one_at_a_time_all_finish(agents_service, nested_scripted, tool_errors):
    async def go():
        run = _NestedRun(agents_service)
        await run.pause_on_three_nested_gates()
        for _ in range(3):
            assert run.pending, "the run lost a pending approval"
            run.pending = await run.leg(run.command(**_approve(run.pending[-1].id)))
        assert run.pending == []
        assert run.state["messages"][-1].content == "All claims researched."

    asyncio.run(go())
    assert tool_errors == []


# ---------------------------------------------------------------------------
# The /resume route
# ---------------------------------------------------------------------------
_A, _B, _C = "a" * 32, "b" * 32, "c" * 32


class _ThreeGatesAgent(_FakeResumeAgent):
    interrupts: ClassVar[list] = [_FakeInterrupt(_A), _FakeInterrupt(_B), _FakeInterrupt(_C)]


def _resume(client, internal_headers, **body):
    return client.post(
        "/agents/omni/resume",
        headers=internal_headers,
        json={"config": {"run_config": {"configurable": {}}}, "thread_id": "t-1", "decision": "approve", **body},
    )


async def test_route_applies_a_batch_keyed_by_interrupt(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch, agent_cls=_ThreeGatesAgent)
    _ThreeGatesAgent.captured_command = {}
    response = await _resume(
        client, internal_headers, interrupt_id=_C,
        resumes=[_approve(_C), _reject(_A, "no")],
    )
    assert response.status_code == 200
    assert _ThreeGatesAgent.captured_command["command"].resume == {
        _C: {"decisions": [{"type": "approve"}]},
        _A: {"decisions": [{"type": "reject", "message": "no"}]},
    }


async def test_route_targets_the_named_interrupt_not_the_first(client, agents_service, internal_headers, monkeypatch):
    _resume_env(agents_service, monkeypatch, agent_cls=_ThreeGatesAgent)
    _ThreeGatesAgent.captured_command = {}
    response = await _resume(client, internal_headers, interrupt_id=_B, decision="reject", reason="later")
    assert response.status_code == 200
    assert _ThreeGatesAgent.captured_command["command"].resume == {
        _B: {"decisions": [{"type": "reject", "message": "later"}]},
    }


async def test_route_refuses_a_batch_with_an_interrupt_that_is_not_pending(
    client, agents_service, internal_headers, monkeypatch,
):
    _resume_env(agents_service, monkeypatch, agent_cls=_ThreeGatesAgent)
    _ThreeGatesAgent.captured_command = {}
    response = await _resume(client, internal_headers, resumes=[_approve(_A), _approve("d" * 32)])
    assert response.status_code == 409
    assert _ThreeGatesAgent.captured_command == {}
    # Listed through the service's error handler, so the bridge can recover.
    detail = response.json()["detail"]
    assert detail["stale_interrupt_ids"] == ["d" * 32]
    assert detail["pending_interrupt_ids"] == [_A, _B, _C]


async def test_route_refuses_a_batch_answering_one_interrupt_twice(
    client, agents_service, internal_headers, monkeypatch,
):
    _resume_env(agents_service, monkeypatch, agent_cls=_ThreeGatesAgent)
    _ThreeGatesAgent.captured_command = {}
    response = await _resume(client, internal_headers, resumes=[_approve(_A), _reject(_A, "no")])
    assert response.status_code == 422
    assert _ThreeGatesAgent.captured_command == {}


class _OneGateAgent(_FakeResumeAgent):
    interrupts: ClassVar[list] = [_FakeInterrupt(_A)]


async def test_route_keys_a_single_pending_interrupt_too(client, agents_service, internal_headers, monkeypatch):
    # Never a bare value for a real interrupt id: a bare value is stored as a
    # run-wide answer a nested sub-agent's later gate could read as its own.
    _resume_env(agents_service, monkeypatch, agent_cls=_OneGateAgent)
    _OneGateAgent.captured_command = {}
    response = await _resume(client, internal_headers, interrupt_id=_A)
    assert response.status_code == 200
    assert _OneGateAgent.captured_command["command"].resume == {_A: {"decisions": [{"type": "approve"}]}}


async def test_route_keeps_a_bare_value_for_an_id_langgraph_would_not_key(
    client, agents_service, internal_headers, monkeypatch,
):
    # Not an id LangGraph reads as a resume map: the bare value it can apply.
    _resume_env(agents_service, monkeypatch)
    _FakeResumeAgent.captured_command = {}
    response = await _resume(client, internal_headers, interrupt_id="int-1")
    assert response.status_code == 200
    assert _FakeResumeAgent.captured_command["command"].resume == {"decisions": [{"type": "approve"}]}
