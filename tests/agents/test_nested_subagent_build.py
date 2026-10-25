"""Sub-agents with sub-agents of their own: the definition and the build.

deepagents builds the main agent's own sub-agents and nothing below them. A
sub-agent that delegates in turn gets a ``SubAgentMiddleware`` from our build
path, and every spec below depth 1 is built there in full. Pinned here:

* **the definition** — at most ``MAX_SUBAGENT_DEPTH`` levels, unique sibling
  names, no name repeated below itself, and tools only ever narrowing on the
  way down (``AgentSpec`` for YAML and user agents, ``validate_subagent_tree``
  for agents written in code);
* **the build** — every level carries the platform middleware, the base stack
  deepagents gives depth 1 (planning, filesystem with the workspace's rules,
  summarization, PatchToolCalls), the run's approval gates (which a spec can
  add to but never clear a locked one from), and never ``ask_user``;
* **the YAML agent** declares the same tree.
"""
from __future__ import annotations

import importlib
from typing import Any

import pytest
from deepagents.backends import StateBackend
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.subagents import SubAgentMiddleware
from langchain.agents.middleware import TodoListMiddleware
from langchain_core.tools import tool
from pydantic import ValidationError


@tool
def search(query: str) -> str:
    """Search the web."""
    return query


@tool
def lookup(claim: str) -> str:
    """Look a claim up."""
    return claim


@tool
def ask_user(question: str) -> str:
    """Ask the user (stands in for the real tool: only its name matters here)."""
    return question


MODEL = "openai:gpt-4.1-mini"


@pytest.fixture
def spec_module(agents_service):
    return importlib.import_module("harness.abstractions.agent_spec")


@pytest.fixture
def tree_module(agents_service):
    return importlib.import_module("harness.abstractions.subagent_tree")


@pytest.fixture
def deep_agent_module(agents_service):
    return importlib.import_module("harness.abstractions.deep_agent")


@pytest.fixture
def middlewares(agents_service):
    return importlib.import_module("harness.middlewares")


def _agent_spec(spec_module, *, tools=(), subagents=()):
    return spec_module.AgentSpec.model_validate(
        {
            "id": "nested-demo-v1",
            "slug": "nested-demo",
            "name": "Nested demo",
            "version": "1.0.0",
            "type": "deep_agent",
            "prompt": "You answer questions.",
            "model": {"main": MODEL},
            "tools": list(tools),
            "subagents": list(subagents),
        }
    )


def _sa(name: str, *children: dict, tools=None) -> dict:
    out: dict[str, Any] = {"name": name, "description": f"The {name}.", "prompt": f"You are the {name}."}
    if tools is not None:
        out["tools"] = tools
    if children:
        out["subagents"] = list(children)
    return out


NATIVE_REMEMBER = {"native": "remember"}
NATIVE_PRESENT = {"native": "present_artifact"}


# ---------------------------------------------------------------------------
# The definition (YAML / user agents)
# ---------------------------------------------------------------------------
def test_three_levels_below_the_agent_are_allowed(spec_module):
    spec = _agent_spec(spec_module, subagents=[_sa("researcher", _sa("fact-checker", _sa("source-verifier")))])
    assert [path for path, _ in spec.walk_subagents()] == [
        ("researcher",),
        ("researcher", "fact-checker"),
        ("researcher", "fact-checker", "source-verifier"),
    ]
    assert spec_module.MAX_SUBAGENT_DEPTH == 3


def test_a_fourth_level_is_refused(spec_module):
    deep = _sa("a", _sa("b", _sa("c", _sa("d"))))
    with pytest.raises(ValidationError, match="'a > b > c > d' is 4 levels below the agent; at most 3"):
        _agent_spec(spec_module, subagents=[deep])


def test_siblings_need_distinct_names(spec_module):
    with pytest.raises(ValidationError, match="under 'researcher' share a name: checker"):
        _agent_spec(spec_module, subagents=[_sa("researcher", _sa("checker"), _sa("checker"))])
    with pytest.raises(ValidationError, match="of the agent share a name: researcher"):
        _agent_spec(spec_module, subagents=[_sa("researcher"), _sa("researcher")])


def test_a_name_cannot_repeat_below_itself(spec_module):
    with pytest.raises(ValidationError, match="'researcher > checker > researcher' repeats a name above it"):
        _agent_spec(spec_module, subagents=[_sa("researcher", _sa("checker", _sa("researcher")))])
    # The same name in two branches is not a loop.
    spec = _agent_spec(spec_module, subagents=[_sa("a", _sa("checker")), _sa("b", _sa("checker"))])
    assert len(list(spec.walk_subagents())) == 4


def test_tools_only_narrow_on_the_way_down(spec_module):
    declared = [NATIVE_REMEMBER, NATIVE_PRESENT]
    # Inheriting at every level, or narrowing step by step, is fine.
    _agent_spec(spec_module, tools=declared, subagents=[_sa("r", _sa("c", tools=[NATIVE_PRESENT]))])
    _agent_spec(
        spec_module,
        tools=declared,
        subagents=[_sa("r", _sa("c", tools=[NATIVE_PRESENT]), tools=[NATIVE_PRESENT, NATIVE_REMEMBER])],
    )
    # A child cannot take back what its parent gave up.
    with pytest.raises(ValidationError, match="'r > c' lists tools sub-agent 'r' does not have: remember"):
        _agent_spec(
            spec_module,
            tools=declared,
            subagents=[_sa("r", _sa("c", tools=[NATIVE_REMEMBER]), tools=[NATIVE_PRESENT])],
        )
    # Nor anything the agent itself was never given.
    with pytest.raises(ValidationError, match="lists tools sub-agent 'r' does not have: create_skill"):
        _agent_spec(spec_module, tools=declared, subagents=[_sa("r", _sa("c", tools=[{"native": "create_skill"}]))])


def test_references_are_collected_at_every_depth(spec_module):
    inner = {**_sa("c", tools=[NATIVE_PRESENT]), "model": "openai:gpt-4o"}
    spec = _agent_spec(spec_module, tools=[NATIVE_PRESENT], subagents=[_sa("r", inner)])
    assert spec.all_model_ids() == sorted({MODEL, "openai:gpt-4o"})
    assert spec.native_tool_names() == ["present_artifact"]


def test_a_user_agent_prompt_reference_is_checked_at_every_depth(agents_service, spec_module):
    user_agents = importlib.import_module("harness.abstractions.user_agents")
    schema = importlib.import_module("schema")
    payload = _agent_spec(
        spec_module,
        subagents=[{**_sa("researcher", {**_sa("checker"), "prompt": "./subagents/checker.md"}),
                    "prompt": "./subagents/researcher.md"}],
    ).model_dump()
    payload["prompt"] = "./AGENT.md"
    files = [schema.AgentFile(path="AGENT.md", content="x"), schema.AgentFile(path="subagents/researcher.md", content="x")]
    monkey_models = [MODEL]
    original = user_agents.settings.registry.allowed_agent_models
    user_agents.settings.registry.allowed_agent_models = monkey_models
    try:
        spec, errors = user_agents.validate_write(
            "u1", payload, files, reserved_slugs=frozenset(), known_skills=frozenset()
        )
    finally:
        user_agents.settings.registry.allowed_agent_models = original
    assert spec is None
    assert errors == [
        "The sub-agent 'researcher > checker' prompt points at 'subagents/checker.md', "
        "which is not among the uploaded files."
    ]


# ---------------------------------------------------------------------------
# The definition (agents written in code)
# ---------------------------------------------------------------------------
def test_a_code_defined_tree_is_held_to_the_same_rules(tree_module):
    sub = tree_module.subagent
    tree_module.validate_subagent_tree([sub("r", "d", "p", subagents=[sub("c", "d", "p", subagents=[sub("s", "d", "p")])])])
    with pytest.raises(ValueError, match="4 levels below the agent"):
        tree_module.validate_subagent_tree(
            [sub("a", "d", "p", subagents=[sub("b", "d", "p", subagents=[sub("c", "d", "p", subagents=[sub("d", "d", "p")])])])]
        )
    with pytest.raises(ValueError, match="repeats a name above it"):
        tree_module.validate_subagent_tree([sub("r", "d", "p", subagents=[sub("r", "d", "p")])])
    looped = sub("r", "d", "p")
    looped["subagents"] = [looped]
    with pytest.raises(ValueError, match="contains itself"):
        tree_module.validate_subagent_tree([looped])
    with pytest.raises(ValueError, match="cannot declare sub-agents"):
        tree_module.validate_subagent_tree([{"name": "x", "description": "d", "runnable": object(), "subagents": [sub("c", "d", "p")]}])


# ---------------------------------------------------------------------------
# The build
# ---------------------------------------------------------------------------
@pytest.fixture
def build(deep_agent_module, monkeypatch):
    """Run the real build_deep_agent; capture what reaches create_deep_agent."""

    class Bare(deep_agent_module.DeepAgent):
        name = "nested-build"

        def register_agent(self):
            return None

    def _build(subagents, *, interrupt_on=None):
        captured: dict[str, Any] = {}
        monkeypatch.setattr(deep_agent_module, "create_deep_agent", lambda **kwargs: captured.update(kwargs))
        agent = Bare()
        monkeypatch.setattr(agent, "_build_composite_backend", lambda: StateBackend)
        agent.tools = [search, lookup, ask_user]
        agent.build_deep_agent(model=MODEL, middleware=[], interrupt_on=interrupt_on or {}, subagents=subagents)
        return captured

    return _build


def _nested(spec: dict) -> dict[str, dict]:
    """The specs a top-level (or nested) spec delegates to, by name."""
    [task] = [m for m in spec["middleware"] if isinstance(m, SubAgentMiddleware)]
    return {child["name"]: child for child in task._subagents}


def _tree(tree_module):
    sub = tree_module.subagent
    return [
        sub(
            "researcher", "Researches.", "You are the researcher.",
            subagents=[
                sub(
                    "fact-checker", "Checks facts.", "You are the fact-checker.", tools=[lookup, ask_user],
                    interrupt_on={"lookup": True, "execute": False},
                    subagents=[sub("source-verifier", "Finds sources.", "You are the source-verifier.")],
                ),
                sub("citer", "Cites.", "You are the citer.", tools=[]),
            ],
        ),
        sub("writer", "Writes.", "You are the writer."),
    ]


def _platform(middlewares) -> tuple[type, ...]:
    return (
        middlewares.ToolErrorMiddleware,
        middlewares.ToolMetricsMiddleware,
        middlewares.RetryOnRateLimitMiddleware,
        middlewares.UsageMetricsMiddleware,
    )


def test_every_level_carries_the_platform_middleware(build, tree_module, middlewares):
    top = {s["name"]: s for s in build(_tree(tree_module))["subagents"]}
    researcher = top["researcher"]
    checker = _nested(researcher)["fact-checker"]
    verifier = _nested(checker)["source-verifier"]
    citer = _nested(researcher)["citer"]

    for spec in (top["general-purpose"], researcher, top["writer"], checker, verifier, citer):
        stack = spec["middleware"]
        for cls in _platform(middlewares):
            assert sum(isinstance(m, cls) for m in stack) == 1, (spec["name"], cls.__name__)
    # Below depth 1 our build adds what deepagents adds at depth 1.
    for spec in (checker, verifier, citer):
        stack = spec["middleware"]
        for cls in (TodoListMiddleware, FilesystemMiddleware, PatchToolCallsMiddleware):
            assert sum(isinstance(m, cls) for m in stack) == 1, (spec["name"], cls.__name__)
        assert any(type(m).__name__.endswith("SummarizationMiddleware") for m in stack), spec["name"]
    # Only a sub-agent with sub-agents has a `task` tool of its own.
    assert [s["name"] for s in (researcher, checker) if any(isinstance(m, SubAgentMiddleware) for m in s["middleware"])] == [
        "researcher", "fact-checker"
    ]
    assert not any(isinstance(m, SubAgentMiddleware) for m in verifier["middleware"] + citer["middleware"])
    assert "subagents" not in researcher


def test_no_subagent_at_any_depth_has_ask_user(build, tree_module):
    top = {s["name"]: s for s in build(_tree(tree_module))["subagents"]}
    researcher = top["researcher"]
    checker = _nested(researcher)["fact-checker"]
    specs = [*top.values(), checker, _nested(checker)["source-verifier"], _nested(researcher)["citer"]]

    for spec in specs:
        assert "ask_user" not in [t.name for t in spec["tools"]], spec["name"]
    # Inheriting means the tools of the agent above, minus ask_user; an explicit
    # list is kept (minus ask_user); an empty one stays empty.
    assert [t.name for t in researcher["tools"]] == ["search", "lookup"]
    assert [t.name for t in checker["tools"]] == ["lookup"]
    assert [t.name for t in _nested(checker)["source-verifier"]["tools"]] == ["lookup"]
    assert _nested(researcher)["citer"]["tools"] == []


def test_gates_apply_at_every_depth_and_a_locked_one_cannot_be_cleared(build, tree_module):
    top = {s["name"]: s for s in build(_tree(tree_module), interrupt_on={"search": True})["subagents"]}
    checker = _nested(top["researcher"])["fact-checker"]
    verifier = _nested(checker)["source-verifier"]

    # The run's gates reach depth 3 (the agent's own `search`, the builtin
    # defaults such as `task`), the spec adds its own, and `execute` stays
    # locked although the spec tried to clear it.
    for spec in (checker, verifier):
        gates = spec["interrupt_on"]
        assert gates["search"] is True and gates["task"] is True and gates["execute"] is True, spec["name"]
    assert checker["interrupt_on"]["lookup"] is True
    assert "lookup" not in verifier["interrupt_on"]
    assert "ask_user" not in checker["interrupt_on"]
    # deepagents compiles `interrupt_on` into the sub-agent's graph as its
    # approval step; that the gated tool really pauses at depth is pinned by
    # the full run in test_nested_subagent_example.py.


def test_a_delegating_subagent_is_told_how_to_use_its_own_subagents(build, tree_module, agents_service):
    prompts = importlib.import_module("harness.prompt_engineering.prompts.capabilities_prompt")
    top = {s["name"]: s for s in build(_tree(tree_module))["subagents"]}
    researcher = top["researcher"]
    checker = _nested(researcher)["fact-checker"]

    assert researcher["system_prompt"].startswith("You are the researcher.")
    assert prompts.DELEGATING_SUBAGENT_PROMPT in researcher["system_prompt"]
    assert prompts.DELEGATING_SUBAGENT_PROMPT in checker["system_prompt"]
    assert prompts.DELEGATING_SUBAGENT_PROMPT not in _nested(checker)["source-verifier"]["system_prompt"]
    assert prompts.DELEGATING_SUBAGENT_PROMPT not in top["writer"]["system_prompt"]


def test_a_tree_too_deep_fails_the_build(build, tree_module):
    sub = tree_module.subagent
    deep = sub("a", "d", "p", subagents=[sub("b", "d", "p", subagents=[sub("c", "d", "p", subagents=[sub("d", "d", "p")])])])
    with pytest.raises(ValueError, match="4 levels below the agent"):
        build([deep])


# ---------------------------------------------------------------------------
# The YAML agent
# ---------------------------------------------------------------------------
def test_every_omni_subagent_can_delegate_two_levels_down(build, tree_module, agents_service):
    """Omni opts in: its general-purpose, researcher and writer sub-agents each
    hand work to a `helper`, which hands work to a `sub-helper` — the third
    level, which does the work itself."""
    omni_module = importlib.import_module("deep_agents.omni_agent")
    agent = omni_module.OmniAgent.__new__(omni_module.OmniAgent)
    agent.skills_paths = []
    specs = agent.register_subagents()
    tree_module.validate_subagent_tree(specs)

    built = build(specs)["subagents"]
    # Declared once by Omni, so the build adds no second general-purpose.
    assert [s["name"] for s in built] == ["general-purpose", "researcher", "writer"]
    for top in built:
        helper = _nested(top)["helper"]
        sub_helper = _nested(helper)["sub-helper"]
        assert not any(isinstance(m, SubAgentMiddleware) for m in sub_helper["middleware"])


def test_the_yaml_agent_declares_the_tree(agents_service, spec_module):
    yaml_module = importlib.import_module("harness.abstractions.yaml_agent")
    agent = yaml_module.YamlDeepAgent.__new__(yaml_module.YamlDeepAgent)
    agent._spec = _agent_spec(
        spec_module,
        tools=[NATIVE_PRESENT],
        subagents=[_sa("researcher", {**_sa("fact-checker", _sa("source-verifier")), "model": "openai:gpt-4o"})],
    )
    agent._source_dir = None
    agent._owner_user_id = None
    agent._definition_files = {}
    agent.context = {}
    agent.name = "nested-demo"
    agent.tools = []

    [researcher] = agent.register_subagents()
    [checker] = researcher["subagents"]
    [verifier] = checker["subagents"]
    assert (researcher["name"], checker["name"], verifier["name"]) == ("researcher", "fact-checker", "source-verifier")
    assert checker["model"] == "openai:gpt-4o" and verifier["model"] == MODEL
    assert verifier["system_prompt"] == "You are the source-verifier."
    assert "tools" not in checker  # inherits
    assert "subagents" not in verifier
