"""`BaseAgent` config validation — the contract its signature advertises.

`_validate_config` takes a `Mapping` and returns a `dict`. A `Mapping` is the
read-only protocol, so validation must not write into the object it was handed.
It used to, and got away with it because every caller passes a plain `dict`;
a `MappingProxyType` — the shape `ToolConfig` already uses elsewhere in this
module — raised `TypeError` instead.
"""
from __future__ import annotations

import importlib
import types

import pytest


@pytest.fixture
def base_agent(agents_service):
    return importlib.import_module("harness.abstractions.base_agent")


@pytest.fixture
def agent_cls(base_agent):
    class _Agent(base_agent.BaseAgent):
        name = "probe"

    return _Agent


VALID_CONTEXT = {"user_id": "u1", "conversation_id": "c1"}


# ---------------------------------------------------------------------------
# It does not mutate what it was given
# ---------------------------------------------------------------------------
def test_the_callers_config_is_left_alone(agent_cls):
    config = {"context": dict(VALID_CONTEXT), "run_config": {"configurable": {"thread_id": "t"}}}
    snapshot = {"context": dict(VALID_CONTEXT), "run_config": {"configurable": {"thread_id": "t"}}}

    agent_cls(config=config)

    assert config == snapshot, "validation wrote back into the caller's mapping"


def test_a_read_only_mapping_is_accepted(agent_cls):
    # The signature says Mapping. This is a Mapping; it must not raise.
    config = types.MappingProxyType(
        {"context": types.MappingProxyType(dict(VALID_CONTEXT))}
    )
    agent = agent_cls(config=config)

    assert agent.context["user_id"] == "u1"


def test_the_returned_config_is_a_separate_object(agent_cls):
    config = {"context": dict(VALID_CONTEXT)}
    agent = agent_cls(config=config)

    assert agent.config is not config


# ---------------------------------------------------------------------------
# It still validates
# ---------------------------------------------------------------------------
def test_context_is_normalised_on_the_copy(agent_cls):
    config = {"context": {"user_id": "  u1  ", "conversation_id": "c1"}}
    agent = agent_cls(config=config)

    assert agent.context["user_id"] == "u1"
    # The caller's copy keeps its original, untrimmed value.
    assert config["context"]["user_id"] == "  u1  "


@pytest.mark.parametrize("missing", ["user_id", "conversation_id"])
def test_a_context_missing_an_id_is_refused(agent_cls, missing):
    context = dict(VALID_CONTEXT)
    del context[missing]
    with pytest.raises(ValueError, match=missing):
        agent_cls(config={"context": context})


@pytest.mark.parametrize("bad", ["", "   "])
def test_a_blank_id_is_refused(agent_cls, bad):
    with pytest.raises(ValueError):
        agent_cls(config={"context": {**VALID_CONTEXT, "user_id": bad}})


def test_a_non_mapping_run_config_is_refused(agent_cls):
    with pytest.raises(TypeError, match="run_config"):
        agent_cls(config={"context": dict(VALID_CONTEXT), "run_config": ["not", "a", "mapping"]})


def test_a_non_mapping_configurable_is_refused(agent_cls):
    with pytest.raises(TypeError, match="configurable"):
        agent_cls(config={"context": dict(VALID_CONTEXT), "run_config": {"configurable": []}})
