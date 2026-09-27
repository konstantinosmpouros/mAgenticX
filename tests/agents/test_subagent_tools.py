"""Sub-agents carry their own model and a tool subset — and never exceed the parent.

Plan 20 §5.3. Three properties are worth pinning:

* **An empty tool list means "inherit".** The ``tools`` key is left off the
  ``SubAgent`` so deepagents hands the sub-agent the parent's full tool list. It
  used to always pass a list — so a sub-agent that named no tools got none, and
  could not even use the search tool its parent was built around.
* **A non-empty list is a restriction, resolved from the parent's filtered
  tools.** A tool the user switched off for the agent is absent for the
  sub-agent too, and a restriction whose tools are all unavailable stays empty
  instead of widening back to "inherit everything".
* **The spec refuses a sub-agent tool the agent does not declare**, so delegating
  can never be a way to reach a tool the agent itself was not given.
"""
from __future__ import annotations

import importlib

import pytest
from pydantic import ValidationError


@pytest.fixture
def spec_module(agents_service):
    return importlib.import_module("harness.abstractions.agent_spec")


@pytest.fixture
def yaml_module(agents_service):
    return importlib.import_module("harness.abstractions.yaml_agent")


def _spec(spec_module, *, tools=(), subagents=()):
    return spec_module.AgentSpec.model_validate(
        {
            "id": "research-bot-v1",
            "slug": "research-bot",
            "name": "Research Bot",
            "version": "1.0.0",
            "type": "deep_agent",
            "prompt": "You research things.",
            "model": {"main": "openai:gpt-4o"},
            "tools": list(tools),
            "subagents": list(subagents),
        }
    )


def _mcp(server: str, tool: str) -> dict:
    return {"server_id": server, "tool_name": tool}


class FakeTool:
    def __init__(self, name: str):
        self.name = name


@pytest.fixture
def build(yaml_module, spec_module, monkeypatch):
    """Run the real `register_subagents` over an agent whose parent tools are given.

    `parent` is the parent's MCP tools *after* the run's filtering, i.e. what
    `attach_tools` left in `self.tools`.
    """
    keys = {"search": "tavily/search", "papers": "arxiv/search_papers", "sql": "rag/sql_query"}
    monkeypatch.setattr(yaml_module, "get_tool_cache_key", lambda tool: keys[tool.name])

    def _build(*, tools, subagents, parent=("search", "papers", "sql")):
        agent = yaml_module.YamlDeepAgent.__new__(yaml_module.YamlDeepAgent)
        agent._spec = _spec(spec_module, tools=tools, subagents=subagents)
        agent._source_dir = None
        agent._owner_user_id = None
        agent._definition_files = {}
        agent.context = {}
        agent.name = "research-bot"
        agent.tools = [FakeTool(n) for n in parent]
        return {sa["name"]: sa for sa in agent.register_subagents()}

    return _build


DECLARED = [_mcp("tavily", "search"), _mcp("arxiv", "search_papers"), _mcp("rag", "sql_query")]


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
def test_a_subagent_naming_no_tools_inherits_the_parents(build):
    subs = build(
        tools=DECLARED,
        subagents=[{"name": "writer", "description": "Writes", "prompt": "Write."}],
    )
    # No `tools` key at all: deepagents then passes the parent's tool list down.
    assert "tools" not in subs["writer"]


def test_an_explicit_subset_gets_exactly_those_tools(build):
    subs = build(
        tools=DECLARED,
        subagents=[
            {
                "name": "researcher",
                "description": "Finds sources",
                "prompt": "Research.",
                "tools": [_mcp("arxiv", "search_papers")],
            }
        ],
    )
    assert [t.name for t in subs["researcher"]["tools"]] == ["papers"]


def test_a_tool_the_user_switched_off_is_absent_for_the_subagent_too(build):
    # The user disabled arXiv for this agent, so the parent's filtered tools
    # no longer carry it — and the sub-agent must not get it back.
    subs = build(
        tools=DECLARED,
        parent=("search", "sql"),
        subagents=[
            {
                "name": "researcher",
                "description": "Finds sources",
                "prompt": "Research.",
                "tools": [_mcp("arxiv", "search_papers"), _mcp("tavily", "search")],
            }
        ],
    )
    assert [t.name for t in subs["researcher"]["tools"]] == ["search"]


def test_a_restriction_with_nothing_available_stays_empty_rather_than_inheriting(build):
    subs = build(
        tools=DECLARED,
        parent=(),
        subagents=[
            {
                "name": "researcher",
                "description": "Finds sources",
                "prompt": "Research.",
                "tools": [_mcp("arxiv", "search_papers")],
            }
        ],
    )
    assert subs["researcher"]["tools"] == []


def test_a_subagent_model_overrides_the_main_one_and_falls_back_to_it(build):
    subs = build(
        tools=DECLARED,
        subagents=[
            {"name": "fast", "description": "Quick", "prompt": "Go.", "model": "openai:gpt-4o-mini"},
            {"name": "default", "description": "Same", "prompt": "Go."},
        ],
    )
    assert subs["fast"]["model"] == "openai:gpt-4o-mini"
    assert subs["default"]["model"] == "openai:gpt-4o"


def test_gates_are_never_set_per_subagent(build):
    # Leaving `interrupt_on` off is what makes a sub-agent inherit the parent's
    # resolved approval gates; setting it here would let a tool skip its gate.
    subs = build(
        tools=DECLARED,
        subagents=[
            {
                "name": "researcher",
                "description": "Finds sources",
                "prompt": "Research.",
                "tools": [_mcp("tavily", "search")],
            }
        ],
    )
    assert "interrupt_on" not in subs["researcher"]


# ---------------------------------------------------------------------------
# Spec validation
# ---------------------------------------------------------------------------
def test_the_spec_accepts_a_subset_and_an_empty_list(spec_module):
    spec = _spec(
        spec_module,
        tools=DECLARED,
        subagents=[
            {"name": "a", "description": "A", "prompt": "A.", "tools": [_mcp("tavily", "search")]},
            {"name": "b", "description": "B", "prompt": "B."},
        ],
    )
    assert [len(sa.tools) for sa in spec.subagents] == [1, 0]


def test_the_spec_refuses_a_subagent_tool_the_agent_does_not_declare(spec_module):
    with pytest.raises(ValidationError, match="does not declare: github/create_issue"):
        _spec(
            spec_module,
            tools=[_mcp("tavily", "search")],
            subagents=[
                {
                    "name": "a",
                    "description": "A",
                    "prompt": "A.",
                    "tools": [_mcp("github", "create_issue")],
                }
            ],
        )


def test_the_rule_covers_native_tools_as_well(spec_module):
    with pytest.raises(ValidationError, match="does not declare: remember"):
        _spec(
            spec_module,
            tools=[],
            subagents=[{"name": "a", "description": "A", "prompt": "A.", "tools": [{"native": "remember"}]}],
        )
