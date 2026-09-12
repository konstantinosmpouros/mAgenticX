"""MCP tool selection: one decode, one pass, builtins out of reach.

The Agents tab lets a user switch a gateway tool on or off for one agent. Those
choices ride the run config and are resolved in `BaseAgent._filter_live_tools`:

    (declared ∪ user-enabled) − user-disabled

Two properties matter enough to pin. **Any** agent must honour them — the union
used to live in `YamlDeepAgent`, so a code-defined deep agent (`OmniAgent`)
ignored the user entirely and ran with no MCP tools while the tab showed them
on. And a **builtin can never be dropped** by this path: only live gateway tools
are considered, so the protection is structural rather than a subtraction that
someone has to remember to apply.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def base_agent_module(agents_service):
    return importlib.import_module("harness.abstractions.base_agent")


class FakeTool:
    def __init__(self, name: str):
        self.name = name


@pytest.fixture
def resolve(base_agent_module, monkeypatch):
    """Run the real `_filter_live_tools` over a stub carrying just its inputs."""
    keys = {
        "tavily-search": "tavily/tavily-search",
        "download_paper": "arxiv/download_paper",
        "sql_query": "rag/sql_query",
    }
    monkeypatch.setattr(
        base_agent_module, "get_tool_cache_key", lambda tool: keys.get(tool.name, tool.name)
    )

    def _resolve(
        *,
        declared=(),
        enabled=(),
        disabled=(),
        live=("tavily-search", "download_paper", "sql_query"),
    ):
        agent = base_agent_module.BaseAgent.__new__(base_agent_module.BaseAgent)
        agent.name = "stub"
        agent.config_tool_names = list(declared)
        agent.tool_config = base_agent_module.ToolConfig(
            enabled=frozenset(enabled), disabled=frozenset(disabled)
        )
        return sorted(t.name for t in agent._filter_live_tools([FakeTool(n) for n in live]))

    return _resolve


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------
def test_an_enabled_tool_attaches_with_nothing_declared(resolve):
    # The shape of the bug this guards: a code-defined agent declares no MCP
    # tools, so only the user's choice can put one on the agent.
    assert resolve(enabled=["tavily/tavily-search"]) == ["tavily-search"]


def test_enabled_unions_with_the_declared_set(resolve):
    assert resolve(declared=["arxiv/download_paper"], enabled=["tavily/tavily-search"]) == [
        "download_paper",
        "tavily-search",
    ]


def test_disabled_subtracts_from_the_declared_set(resolve):
    assert resolve(declared=["arxiv/download_paper", "rag/sql_query"], disabled=["rag/sql_query"]) == [
        "download_paper"
    ]


def test_disabled_beats_enabled_for_the_same_key(resolve):
    # Both axes cannot be set for one key by the store, but the run config is
    # untrusted input — the safe resolution is "off".
    assert resolve(enabled=["rag/sql_query"], disabled=["rag/sql_query"]) == []


def test_declaring_a_tool_the_user_also_enabled_attaches_it_once(resolve):
    assert resolve(declared=["arxiv/download_paper"], enabled=["arxiv/download_paper"]) == [
        "download_paper"
    ]


def test_nothing_declared_and_nothing_enabled_attaches_nothing(resolve):
    # An agent with no tool config gets none, rather than the whole gateway.
    assert resolve() == []


def test_a_key_matching_no_live_tool_attaches_nothing(resolve):
    assert resolve(enabled=["gone/vanished"]) == []


# ---------------------------------------------------------------------------
# Builtins are structurally out of reach
# ---------------------------------------------------------------------------
def test_a_disable_naming_a_builtin_cannot_drop_anything(resolve):
    # `write_file` is never a live gateway tool, so it cannot be matched here at
    # all — the old explicit "subtract natives" guard is no longer needed.
    assert resolve(declared=["arxiv/download_paper"], disabled=["write_file"]) == [
        "download_paper"
    ]


# ---------------------------------------------------------------------------
# Decoding the run config
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("carried", [None, {}, [], "nonsense", 42])
def test_junk_decodes_to_an_empty_config(base_agent_module, carried):
    # The field crosses a service boundary as JSON; anything unparseable must
    # degrade to "no choices", never to a guess.
    cfg = base_agent_module.ToolConfig.from_context({"tool_config": carried})
    assert (cfg.enabled, cfg.disabled, dict(cfg.approvals)) == (frozenset(), frozenset(), {})


def test_a_missing_key_decodes_to_an_empty_config(base_agent_module):
    assert base_agent_module.ToolConfig.from_context({}) == base_agent_module.ToolConfig()
    assert base_agent_module.ToolConfig.from_context(None) == base_agent_module.ToolConfig()


def test_non_string_entries_are_dropped_not_stringified(base_agent_module):
    cfg = base_agent_module.ToolConfig.from_context(
        {"tool_config": {"enabled": [None, 7, "arxiv/download_paper", ""]}}
    )
    assert cfg.enabled == frozenset({"arxiv/download_paper"})


def test_each_axis_decodes_independently(base_agent_module):
    cfg = base_agent_module.ToolConfig.from_context(
        {
            "tool_config": {
                "enabled": ["a/b"],
                "disabled": ["c/d"],
                "approvals": {"write_file": False},
            }
        }
    )
    assert cfg.enabled == frozenset({"a/b"})
    assert cfg.disabled == frozenset({"c/d"})
    assert dict(cfg.approvals) == {"write_file": False}
