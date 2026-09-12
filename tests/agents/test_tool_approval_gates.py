"""Approval gates reaching ``interrupt_on``.

Four layers feed it, and only the third belongs to the user::

    {**builtin_defaults, **agent_own} + user choices, then locked_gates()

The user layer is a **map**, not a set: a prebuilt tool can default to gated, so
``False`` has to mean "clear that default" and not merely "no opinion".
``locked_gates()`` is applied last so nothing beneath it can clear a mandated
gate — the enforcement point for ``execute``, replacing a save-time floor check
whose client-side copy drifted twice.

The keying trap is the other thing worth pinning. The Agents tab speaks in cache
keys (``arxiv/download_paper``) but ``interrupt_on`` is keyed by the tool's own
name, and MCP names arrive from the gateway unprefixed. Passing a cache key
straight through matches nothing: the UI shows the gate armed and the tool runs
unapproved every time — invisible until someone audits it.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def deep_agent_module(agents_service):
    return importlib.import_module("harness.abstractions.deep_agent")


@pytest.fixture
def base_agent_module(agents_service):
    return importlib.import_module("harness.abstractions.base_agent")


class FakeTool:
    def __init__(self, name: str):
        self.name = name


def _stub_agent(deep_agent_module, base_agent_module, approvals):
    """A concrete DeepAgent carrying only what `_user_hitl_gates` reads.

    DeepAgent is abstract, so `__new__` on it directly raises; a throwaway
    subclass is the smallest thing that satisfies that without dragging in a
    model and the whole mount stack.
    """

    class Agent(deep_agent_module.DeepAgent):
        name = "stub"

        def register_agent(self):  # pragma: no cover
            raise NotImplementedError

    agent = Agent.__new__(Agent)
    agent.tool_config = base_agent_module.ToolConfig(approvals=dict(approvals))
    return agent


@pytest.fixture
def resolve(deep_agent_module, base_agent_module, monkeypatch):
    """Run the real ``_user_hitl_gates`` for a given set of approvals."""
    keys = {"download_paper": "arxiv/download_paper", "search_papers": "arxiv/search_papers"}
    monkeypatch.setattr(
        deep_agent_module, "get_tool_cache_key", lambda tool: keys.get(tool.name, tool.name)
    )

    def _resolve(approvals: dict, tool_names=("download_paper", "search_papers")):
        agent = _stub_agent(deep_agent_module, base_agent_module, approvals)
        return agent._user_hitl_gates([FakeTool(n) for n in tool_names])

    return _resolve


# ---------------------------------------------------------------------------
# Key to name, per kind
# ---------------------------------------------------------------------------
def test_a_qualified_mcp_key_gates_the_bare_tool_name(resolve):
    assert resolve({"arxiv/download_paper": True}) == {"download_paper": True}


def test_a_builtin_gates_under_its_own_name(resolve):
    # A builtin is never in `tools` — the framework constructs it — so it can
    # only be matched by name.
    assert resolve({"write_file": True}) == {"write_file": True}


def test_both_kinds_resolve_together(resolve):
    assert resolve({"arxiv/search_papers": True, "task": True}) == {"search_papers": True, "task": True}


def test_a_key_matching_nothing_gates_nothing(resolve):
    # A stale row for a vanished MCP server, or a name that is not a builtin,
    # must not invent a gate.
    assert resolve({"gone/vanished": True, "not_a_builtin": True}) == {}


# ---------------------------------------------------------------------------
# Direction
# ---------------------------------------------------------------------------
def test_gates_are_only_ever_true(resolve):
    assert all(
        v is True
        for v in resolve({"arxiv/download_paper": True, "write_file": True}).values()
    )


@pytest.mark.parametrize(
    "carried", [None, [], "download_paper", 42, {"a": 1}, {"": True}, {7: True}]
)
def test_junk_decodes_to_no_approvals(base_agent_module, carried):
    cfg = base_agent_module.ToolConfig.from_context({"tool_config": {"approvals": carried}})
    assert dict(cfg.approvals) == {}


def test_a_tool_without_a_name_is_skipped(deep_agent_module, base_agent_module, monkeypatch):
    # A malformed tool object must not raise inside agent build, which would
    # fail the user's run outright.
    monkeypatch.setattr(deep_agent_module, "get_tool_cache_key", lambda tool: "x/y")
    agent = _stub_agent(deep_agent_module, base_agent_module, {"x/y": True})
    assert agent._user_hitl_gates([FakeTool("")]) == {}


# ---------------------------------------------------------------------------
# The full merge, through the real build_deep_agent
# ---------------------------------------------------------------------------
@pytest.fixture
def built(deep_agent_module, base_agent_module, monkeypatch):
    """Run the real ``build_deep_agent`` and return the ``interrupt_on`` it built.

    Everything expensive is stubbed, but the resolution itself is the real code
    path — asserting on a re-implementation would pass while the runtime
    disarmed every gate.
    """
    captured: dict = {}

    def fake_create(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(deep_agent_module, "create_deep_agent", fake_create)
    monkeypatch.setattr(deep_agent_module, "exclude_stock_summarization", lambda _m: None)
    monkeypatch.setattr(deep_agent_module, "workspace_write_deny", lambda *a, **k: {})
    monkeypatch.setattr(deep_agent_module, "builtin_hitl_defaults", lambda: {"write_file": True})
    monkeypatch.setattr(deep_agent_module, "locked_gates", lambda: {"execute": True})

    def _build(*, class_gates=None, interrupt_on=None, approvals=None, tool_names=()):
        class Agent(deep_agent_module.DeepAgent):
            name = "stub-agent"
            agent_id = "Stub"
            label = "Stub"
            version = "1.0.0"
            hitl_gates = class_gates or {}

            def register_agent(self):  # pragma: no cover
                raise NotImplementedError

        agent = Agent.__new__(Agent)
        agent.context = {}
        agent.tool_config = base_agent_module.ToolConfig(approvals=dict(approvals or {}))
        agent.tools = [FakeTool(n) for n in tool_names]
        agent.checkpointer = None
        agent.agent_md_paths = None
        agent.skills_paths = None
        monkeypatch.setattr(type(agent), "_build_composite_backend", lambda self: object())
        monkeypatch.setattr(type(agent), "default_middleware", lambda self, m, b: [])
        monkeypatch.setattr(type(agent), "_builtin_tools", lambda self: [])
        monkeypatch.setattr(type(agent), "_personalization_system_prompt", lambda self: "")
        monkeypatch.setattr(type(agent), "_memory_system_prompt", lambda self: "")
        monkeypatch.setattr(type(agent), "reference_dir", property(lambda self: None))
        monkeypatch.setattr(type(agent), "default_skills_dir", property(lambda self: None))
        agent.build_deep_agent(model="stub-model", interrupt_on=interrupt_on)
        return captured["interrupt_on"]

    return _build


def test_a_locked_gate_survives_a_user_attempt_to_clear_it(built):
    # The whole point of merging locked_gates() last: nothing below it can
    # remove `execute`. This replaced the save-time floor whose client-side copy
    # drifted and broke every agent save, twice.
    assert built()["execute"] is True
    assert built(class_gates={"execute": False})["execute"] is True


def test_the_class_attribute_gates_when_no_argument_is_passed(built):
    # Dropping `interrupt_on=` from OmniAgent.register_agent() must not disarm.
    assert built(class_gates={"task": True})["task"] is True


def test_an_explicit_map_wins_over_the_class_attribute(built):
    gates = built(class_gates={"task": True}, interrupt_on={"create_skill": True})
    assert gates.get("task") is None
    assert gates["create_skill"] is True


def test_an_explicit_empty_map_stays_empty(built):
    # `is not None`, not truthiness: a spec declaring no gates passes {} and must
    # not fall back to the class attribute.
    assert built(class_gates={"task": True}, interrupt_on={}).get("task") is None


def test_a_user_gate_is_added_on_top(built, deep_agent_module, monkeypatch):
    monkeypatch.setattr(
        deep_agent_module,
        "get_tool_cache_key",
        lambda t: "arxiv/download_paper" if t.name == "download_paper" else t.name,
    )
    gates = built(approvals={"arxiv/download_paper": True}, tool_names=("download_paper",))
    assert gates["download_paper"] is True
    assert gates["write_file"] is True  # builtin default survives
    assert gates["execute"] is True  # locked survives


def test_a_user_can_clear_a_default_gate(built):
    # The whole reason approvals are a map. `write_file` defaults to gated, and
    # switching that off has to actually reach interrupt_on.
    assert built(approvals={"write_file": False}).get("write_file") is None


def test_clearing_cannot_reach_a_locked_gate(built):
    # Same request against the one tool nobody may ungate.
    assert built(approvals={"execute": False})["execute"] is True
