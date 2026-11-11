"""Reasoning effort: the user's level reaches every model call that accepts it, and nothing else."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from pydantic import ValidationError

from core.settings import ModelInfo
from harness.abstractions import deep_agent as deep_agent_module
from harness.abstractions.deep_agent import DeepAgent
from harness.async_tasks.runner import task_context
from harness.async_tasks.token import InheritedContext
from harness.models import (
    EffortMiddleware,
    default_effort,
    effort_model_settings,
    model_spec_of,
    parse_effort,
    supported_efforts,
)


def _openai(name: str, **kwargs: Any) -> ChatOpenAI:
    return ChatOpenAI(model=name, use_responses_api=True, api_key="sk-test", **kwargs)


class _StopBeforeNetwork(Exception):
    """Raised by the payload spy: the request is built, nothing is sent."""


def _sent_reasoning(monkeypatch, model: ChatOpenAI, middleware: list[Any]) -> dict[str, Any] | None:
    """The ``reasoning`` field of the request the agent would send for one turn."""
    seen: list[Any] = []
    original = ChatOpenAI._get_request_payload

    def spy(self, input_, *, stop=None, **kwargs):
        seen.append(original(self, input_, stop=stop, **kwargs).get("reasoning"))
        raise _StopBeforeNetwork

    monkeypatch.setattr(ChatOpenAI, "_get_request_payload", spy)
    agent = create_agent(model=model, tools=[], middleware=middleware)
    with pytest.raises(_StopBeforeNetwork):
        asyncio.run(agent.ainvoke({"messages": [HumanMessage("hi")]}))
    return seen[0]


# --- what each model accepts --------------------------------------------------

def test_reasoning_models_offer_three_levels_and_start_on_medium():
    assert supported_efforts("openai:gpt-6-luna") == ("low", "medium", "high")
    assert default_effort("openai:gpt-6-luna") == "medium"
    assert supported_efforts("openai:gpt-4o") == ()
    assert default_effort("openai:gpt-4o") is None
    assert supported_efforts("openai:not-listed") == ()


def test_a_default_the_model_does_not_accept_is_refused():
    with pytest.raises(ValidationError, match="default_effort must be one of efforts"):
        ModelInfo(reasoning=True, efforts=("low",), default_effort="high")
    with pytest.raises(ValidationError):
        ModelInfo(efforts=("turbo",))


@pytest.mark.parametrize("value, expected", [
    ("high", "high"), ("minimal", "minimal"), ("HIGH", None), ("turbo", None), (3, None), (None, None),
])
def test_an_unknown_level_is_dropped(value, expected):
    assert parse_effort(value) == expected


def test_a_model_is_named_as_the_model_list_names_it():
    assert model_spec_of(_openai("gpt-6-luna")) == "openai:gpt-6-luna"
    assert model_spec_of(object()) is None


# --- what is sent ------------------------------------------------------------------

def test_the_effort_keeps_the_reasoning_summary():
    model = _openai("gpt-6-luna", reasoning={"summary": "auto"})
    assert effort_model_settings(model, {}, "high") == {"reasoning": {"summary": "auto", "effort": "high"}}


def test_a_level_the_model_does_not_list_sends_nothing():
    assert effort_model_settings(_openai("gpt-6-luna"), {}, "xhigh") is None
    assert effort_model_settings(_openai("gpt-4o"), {}, "high") is None


def test_the_request_carries_the_effort_and_the_summary(monkeypatch):
    model = _openai("gpt-6-luna", reasoning={"summary": "auto"})
    assert _sent_reasoning(monkeypatch, model, [EffortMiddleware("low")]) == {"summary": "auto", "effort": "low"}


def test_a_model_without_efforts_gets_exactly_what_it_got_before(monkeypatch):
    without = _sent_reasoning(monkeypatch, _openai("gpt-4o"), [])
    monkeypatch.undo()
    with_it = _sent_reasoning(monkeypatch, _openai("gpt-4o"), [EffortMiddleware("high")])
    assert with_it == without is None


# --- through a deep agent ------------------------------------------------------------

class _EffortAgent(DeepAgent):
    name = "effort-test-deep"

    def register_agent(self):
        return None


def _agent(context: dict[str, Any]) -> _EffortAgent:
    return _EffortAgent(config={"context": {"user_id": "u1", "conversation_id": "c1", "run_id": "r1", **context}})


def test_the_run_context_s_effort_is_read_and_a_bad_one_ignored():
    assert _agent({"effort": "high"}).effort == "high"
    assert _agent({"effort": "turbo"}).effort is None
    assert _agent({}).effort is None


def test_the_main_agent_and_every_sub_agent_get_the_effort(monkeypatch):
    captured: dict[str, Any] = {}
    monkeypatch.setattr(deep_agent_module, "create_deep_agent", lambda **kwargs: captured.update(kwargs))
    agent = _agent({"effort": "high"})
    monkeypatch.setattr(agent, "_build_composite_backend", lambda: None)
    # Blocking sub-agents: built here. (Async ones are task nodes, which get it
    # from their launcher: test_a_background_task_inherits_the_effort.)
    monkeypatch.setattr(agent, "_uses_async_subagents", lambda subagents: False)
    monkeypatch.setattr(agent, "_builtin_tools", lambda: [])  # they need the databases
    agent.build_deep_agent(
        model="openai:gpt-6-luna",
        middleware=[],
        interrupt_on={},
        subagents=[{"name": "researcher", "description": "d", "system_prompt": "p"}],
    )

    def efforts(stack):
        return [m.effort for m in stack if isinstance(m, EffortMiddleware)]

    assert efforts(captured["middleware"]) == ["high"]
    assert all(efforts(sub["middleware"]) == ["high"] for sub in captured["subagents"])


def test_no_effort_means_no_middleware(monkeypatch):
    captured: dict[str, Any] = {}
    monkeypatch.setattr(deep_agent_module, "create_deep_agent", lambda **kwargs: captured.update(kwargs))
    agent = _agent({})
    monkeypatch.setattr(agent, "_build_composite_backend", lambda: None)
    monkeypatch.setattr(agent, "_builtin_tools", lambda: [])  # they need the databases
    agent.build_deep_agent(model="openai:gpt-6-luna", middleware=[], interrupt_on={}, subagents=[])
    assert not any(isinstance(m, EffortMiddleware) for m in captured["middleware"])


def test_a_background_task_inherits_the_effort():
    inherited = _agent({"effort": "low"})._inherited_context()
    assert inherited.effort == "low"
    task = {
        "user_id": "u1", "conversation_id": "c1", "branch_thread_id": "b1", "task_id": "t1",
        "context": inherited.model_dump(),
    }
    assert task_context(task, "run-1")["effort"] == "low"
    # A task started before effort existed has none, and its context no key.
    task["context"] = InheritedContext().model_dump(exclude={"effort"})
    assert "effort" not in task_context(task, "run-1")


# --- the composer's question -------------------------------------------------------

async def test_a_deep_agent_reports_its_model_s_efforts(client, internal_headers):
    response = await client.get("/agents/u1/omni-agent-v1/model", headers=internal_headers)
    assert response.status_code == 200
    assert response.json() == {
        "agentSlug": "omni-agent-v1",
        "model": "openai:gpt-6-luna",
        "efforts": ["low", "medium", "high"],
        "defaultEffort": "medium",
    }


async def test_a_langgraph_agent_offers_no_effort(client, internal_headers):
    response = await client.get("/agents/u1/hr-policies-agent-v1/model", headers=internal_headers)
    assert response.status_code == 200
    assert response.json()["efforts"] == [] and response.json()["defaultEffort"] is None


async def test_an_unknown_agent_is_404_and_a_browser_is_refused(client, internal_headers, monkeypatch):
    async def no_user_agent(user_id, slug):
        return None

    # Not a platform agent, then not one of this user's (no database here).
    monkeypatch.setattr("utils.agents._load_user_agent", no_user_agent)
    assert (await client.get("/agents/u1/nope/model", headers=internal_headers)).status_code == 404
    assert (await client.get("/agents/u1/omni-agent-v1/model")).status_code == 403
