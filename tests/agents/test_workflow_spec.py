"""Workflow engine — spec validation, templating and the branching nodes' logic.

Pins the rules the builder and the bridge rely on: every problem comes back
node-addressed in one pass; templating is path substitution only (no
evaluation, single pass, typed whole-placeholders); rules are strict; loops are
bounded; the catalogue exposes each kind's config JSON Schema.
"""
from __future__ import annotations

import copy
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

EXAMPLE = (
    Path(__file__).resolve().parent / "fixtures" / "workflows" / "fetch_loop_approval.json"
)


@pytest.fixture
def wf(agents_service):
    """The live workflow modules (imported after the service load, so they are
    the same objects the app uses)."""
    names = ["spec", "validator", "templating", "rules", "errors", "catalog", "nodes", "nodes.base"]
    return SimpleNamespace(
        **{name.replace(".", "_"): importlib.import_module(f"harness.workflows.{name}") for name in names}
    )


def _example() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def _minimal(**overrides) -> dict:
    spec = {
        "version": 1,
        "name": "minimal",
        "nodes": [
            {"id": "start", "kind": "trigger.manual", "config": {}},
            {"id": "done", "kind": "end", "config": {}},
        ],
        "edges": [{"id": "e1", "source": "start", "target": "done"}],
    }
    spec.update(overrides)
    return spec


def _messages(issues) -> list[str]:
    return [issue.message for issue in issues]


# -- validator ---------------------------------------------------------------


def test_the_example_and_a_minimal_spec_are_valid(wf):
    for raw in (_example(), _minimal()):
        spec, issues = wf.validator.validate_spec(raw)
        assert issues == [] and spec is not None


def test_every_workflow_has_a_title(wf):
    for blank in ("", "   "):
        spec, issues = wf.validator.validate_spec(_minimal(name=blank))
        assert spec is None
        assert any(issue.path == "name" for issue in issues)
    spec, issues = wf.validator.validate_spec(_minimal(name="  Nightly  "))
    assert issues == [] and spec is not None and spec.name == "Nightly"


def test_unknown_keys_are_refused_everywhere(wf):
    raw = _minimal()
    raw["extra"] = 1
    raw["nodes"][0]["colour"] = "red"
    spec, issues = wf.validator.validate_spec(raw)
    assert spec is None
    paths = {issue.path for issue in issues}
    assert "extra" in paths and "nodes[0].colour" in paths
    assert any(issue.node_id == "start" for issue in issues)


def test_size_and_node_caps_are_checked_before_parsing(wf):
    raw = _minimal(description="x" * (257 * 1024))
    _, issues = wf.validator.validate_spec(raw)
    assert "KiB" in issues[0].message

    raw = _minimal()
    raw["nodes"] = [{"id": f"n{i}", "kind": "end", "config": {}} for i in range(51)]
    _, issues = wf.validator.validate_spec(raw)
    assert issues[0].path == "nodes" and "50" in issues[0].message


def test_unknown_kind_and_bad_config_are_node_addressed(wf):
    raw = _minimal()
    raw["nodes"].append({"id": "x", "kind": "eval_python", "config": {}})
    raw["nodes"].append({"id": "f", "kind": "fetch", "config": {"url": "https://a.example", "timeout_seconds": 99}})
    raw["edges"] += [
        {"id": "e2", "source": "start", "target": "x"},
    ]
    _, issues = wf.validator.validate_spec(raw)
    by_node = {(i.node_id, i.path) for i in issues}
    assert ("x", "nodes[2].kind") in by_node
    assert ("f", "nodes[3].config.timeout_seconds") in by_node


def test_exactly_one_trigger(wf):
    raw = _minimal()
    raw["nodes"].append({"id": "start2", "kind": "trigger.manual", "config": {}})
    _, issues = wf.validator.validate_spec(raw)
    assert any("exactly one trigger" in m for m in _messages(issues))

    raw = _minimal(nodes=[{"id": "done", "kind": "end", "config": {}}], edges=[])
    _, issues = wf.validator.validate_spec(raw)
    assert any("found 0" in m for m in _messages(issues))


def test_edges_must_reference_nodes_and_valid_branches(wf):
    raw = _example()
    raw["edges"].append({"id": "bad1", "source": "ghost", "target": "finish"})
    raw["edges"].append({"id": "bad2", "source": "poll", "target": "ghost"})
    raw["edges"].append({"id": "bad3", "source": "is_ready", "target": "finish", "branch": "maybe"})
    raw["edges"].append({"id": "bad4", "source": "start", "target": "finish", "branch": "true"})
    raw["edges"].append({"id": "bad5", "source": "finish", "target": "poll"})
    _, issues = wf.validator.validate_spec(raw)
    messages = " | ".join(_messages(issues))
    assert "'ghost' is not a node" in messages
    assert "Unknown branch 'maybe'" in messages
    assert "'start' does not branch" in messages or "already has" in messages
    assert "An end node has no outgoing edges" in messages


def test_a_branching_edge_needs_its_label_and_one_edge_per_branch(wf):
    raw = _example()
    raw["edges"] = [e for e in raw["edges"] if e["id"] != "e3"]
    raw["edges"].append({"id": "e3", "source": "is_ready", "target": "approve"})
    raw["edges"].append({"id": "dup", "source": "is_ready", "target": "finish", "branch": "false"})
    _, issues = wf.validator.validate_spec(raw)
    messages = " | ".join(_messages(issues))
    assert "need a branch" in messages
    assert "already has branch 'false'" in messages


def test_every_node_must_be_reachable(wf):
    raw = _minimal()
    raw["nodes"].append({"id": "island", "kind": "end", "config": {}})
    _, issues = wf.validator.validate_spec(raw)
    assert [(i.node_id, i.path) for i in issues] == [("island", "nodes")]


def test_cycles_only_through_a_loop_continue_edge(wf):
    raw = _example()
    # A back edge that bypasses the loop: is_ready(false) -> poll directly.
    for edge in raw["edges"]:
        if edge["id"] == "e4":
            edge["target"] = "poll"
    raw["nodes"] = [n for n in raw["nodes"] if n["id"] != "retry"]
    raw["edges"] = [e for e in raw["edges"] if e["source"] != "retry"]
    _, issues = wf.validator.validate_spec(raw)
    assert any("does not go through a loop" in m for m in _messages(issues))

    # The loop's 'done' edge leading back into the cycle is also refused.
    raw = _example()
    for edge in raw["edges"]:
        if edge["id"] == "e6":
            edge["target"] = "poll"
    _, issues = wf.validator.validate_spec(raw)
    assert any("does not go through a loop" in m for m in _messages(issues))


def test_loop_caps_and_continue_edge(wf):
    raw = _example()
    raw["nodes"][3]["config"]["max_iterations"] = 21
    _, issues = wf.validator.validate_spec(raw)
    assert any(i.path == "nodes[3].config.max_iterations" for i in issues)

    raw = _example()
    raw["edges"] = [e for e in raw["edges"] if e["id"] != "e5"]
    _, issues = wf.validator.validate_spec(raw)
    assert any("needs a 'continue' edge" in m for m in _messages(issues))


def test_template_references_must_exist(wf):
    raw = _example()
    raw["nodes"][1]["config"]["url"] = "{{input.nope}}"
    raw["nodes"][2]["config"]["rules"][0]["path"] = "nodes.ghost.output.status"
    raw["nodes"][4]["config"]["payload"] = "{{state.missing}} {{nodes.poll.status}}"
    raw["nodes"][5]["config"]["assign"] = {"undeclared": "{{output.status}}"}
    _, issues = wf.validator.validate_spec(raw)
    messages = " | ".join(_messages(issues))
    assert "undeclared input 'nope'" in messages
    assert "unknown node 'ghost'" in messages
    assert "must read a node's output" in messages
    assert "'undeclared' is not a declared state field" in messages
    assert {i.node_id for i in issues} == {"poll", "is_ready", "approve", "finish"}


def test_output_root_is_only_allowed_in_assign(wf):
    raw = _example()
    raw["nodes"][1]["config"]["url"] = "{{output.body}}"
    _, issues = wf.validator.validate_spec(raw)
    assert any(i.node_id == "poll" and "must start with one of" in i.message for i in issues)


def test_names_reducers_and_defaults(wf):
    raw = _minimal(
        state=[
            {"name": "nodes", "type": "object"},
            {"name": "items", "type": "string", "reducer": "append"},
            {"name": "bag", "type": "array", "reducer": "merge"},
            {"name": "n", "type": "number", "default": "five"},
            {"name": "done", "type": "string"},
        ],
        inputs=[{"name": "a", "type": "boolean", "default": "yes"}, {"name": "a"}],
    )
    _, issues = wf.validator.validate_spec(raw)
    messages = " | ".join(_messages(issues))
    assert "'nodes' is reserved" in messages
    assert "append reducer needs an array" in messages
    assert "merge reducer needs an object" in messages
    assert "default must be of type number" in messages
    assert "default must be of type boolean" in messages
    assert "Input 'a' is declared more than once" in messages
    assert "clashes with a state name" in messages  # node 'done' vs field 'done'


def test_router_case_names(wf):
    raw = _minimal()
    raw["nodes"].insert(
        1,
        {
            "id": "r",
            "kind": "router",
            "config": {
                "cases": [
                    {"name": "a", "rules": [{"path": "input.x", "op": "exists"}]},
                    {"name": "a", "rules": [{"path": "input.x", "op": "exists"}]},
                    {"name": "default", "rules": [{"path": "input.x", "op": "exists"}]},
                ]
            },
        },
    )
    raw["inputs"] = [{"name": "x"}]
    raw["edges"] = [
        {"id": "e1", "source": "start", "target": "r"},
        {"id": "e2", "source": "r", "target": "done", "branch": "a"},
        {"id": "e3", "source": "r", "target": "done", "branch": "default"},
    ]
    _, issues = wf.validator.validate_spec(raw)
    messages = " | ".join(_messages(issues))
    assert "used twice" in messages and "'default' is reserved" in messages


def test_tool_refs_are_checked_against_the_catalogue(wf):
    raw = _minimal()
    raw["nodes"].insert(1, {"id": "t", "kind": "tool", "config": {"tool": {"source": "mcp", "name": "tavily-search"}}})
    raw["nodes"].insert(2, {"id": "n", "kind": "tool", "config": {"tool": {"source": "native", "name": "forget"}}})
    raw["edges"] = [
        {"id": "e1", "source": "start", "target": "t"},
        {"id": "e2", "source": "t", "target": "n"},
        {"id": "e3", "source": "n", "target": "done"},
    ]
    _, issues = wf.validator.validate_spec(raw, known_mcp_tools=frozenset({"search_papers"}))
    assert {i.node_id for i in issues} == {"t", "n"}
    # Catalogue unreadable (None): MCP refs are not checked, native still is.
    _, issues = wf.validator.validate_spec(raw, known_mcp_tools=None)
    assert {i.node_id for i in issues} == {"n"}


def test_issue_serializes_with_node_id_key(wf):
    issue = wf.validator.ValidationIssue("poll", "nodes[1].config.url", "bad")
    assert issue.as_dict() == {"nodeId": "poll", "path": "nodes[1].config.url", "message": "bad"}


# -- templating --------------------------------------------------------------

SCOPE = {
    "input": {"url": "https://a.example", "n": 3},
    "state": {"items": ["x", "y"], "flag": True, "obj": {"k": 1}},
    "nodes": {"poll": {"output": {"status": 200, "body": {"list": [{"id": "a1"}]}}}},
}


def test_whole_placeholder_keeps_its_type_and_embedded_ones_stringify(wf):
    render = wf.templating.render
    assert render("{{input.n}}", SCOPE) == 3
    assert render("{{ state.obj }}", SCOPE) == {"k": 1}
    assert render("n={{input.n}} flag={{state.flag}} obj={{state.obj}}", SCOPE) == 'n=3 flag=true obj={"k":1}'
    assert render({"a": ["{{nodes.poll.output.body.list.0.id}}", 5, None]}, SCOPE) == {"a": ["a1", 5, None]}


def test_keys_are_never_templated(wf):
    assert wf.templating.render({"{{input.n}}": "v"}, SCOPE) == {"{{input.n}}": "v"}


def test_substitution_is_single_pass(wf):
    scope = copy.deepcopy(SCOPE)
    scope["nodes"]["poll"]["output"]["evil"] = "{{state.obj}}"
    assert wf.templating.render("got {{nodes.poll.output.evil}}", scope) == "got {{state.obj}}"
    assert wf.templating.render("{{nodes.poll.output.evil}}", scope) == "{{state.obj}}"


def test_missing_paths_and_bad_syntax_raise(wf):
    TemplateError = wf.errors.TemplateError
    for template in (
        "{{input.missing}}",
        "{{nodes.poll.output.body.list.5}}",
        "{{nodes.poll.output.status.deeper}}",
        "{{nodes.other.output}}",
        "{{env.HOME}}",
        "{{input.n + 1}}",
        "{{input.__class__.__mro__}}",
        "{{ input }}",
    ):
        with pytest.raises(TemplateError):
            wf.templating.render(template, SCOPE)


def test_render_never_aliases_state(wf):
    out = wf.templating.render("{{state.obj}}", SCOPE)
    out["k"] = 99
    assert SCOPE["state"]["obj"] == {"k": 1}


# -- rules ---------------------------------------------------------------------


def _rule(wf, path, op, value=None):
    return wf.rules.Rule(path=path, op=op, value=value)


@pytest.mark.parametrize(
    ("path", "op", "value", "expected"),
    [
        ("nodes.poll.output.status", "eq", 200, True),
        ("nodes.poll.output.status", "ne", 200, False),
        ("nodes.poll.output.status", "gt", 199, True),
        ("nodes.poll.output.status", "gte", 200, True),
        ("nodes.poll.output.status", "lt", 200, False),
        ("nodes.poll.output.status", "lte", "300", False),  # number vs string: never ordered
        ("input.url", "contains", "a.example", True),
        ("state.items", "contains", "y", True),
        ("state.obj", "contains", "k", True),
        ("state.flag", "eq", 1, False),  # a boolean only equals a boolean
        ("state.flag", "eq", True, True),
        ("input.missing", "exists", None, False),
        ("input.url", "exists", None, True),
        ("input.missing", "empty", None, True),
        ("state.items", "empty", None, False),
    ],
)
def test_rule_operators(wf, path, op, value, expected):
    assert wf.rules.evaluate_rule(_rule(wf, path, op, value), SCOPE) is expected


def test_a_missing_path_fails_loudly_except_for_exists_and_empty(wf):
    with pytest.raises(wf.errors.TemplateError):
        wf.rules.evaluate_rule(_rule(wf, "input.missing", "eq", 1), SCOPE)


def test_rule_paths_cannot_be_templates(wf):
    with pytest.raises(ValidationError):
        wf.rules.Rule(path="{{input.url}}", op="exists")


def test_all_and_any(wf):
    rules = [_rule(wf, "input.n", "eq", 3), _rule(wf, "input.n", "eq", 4)]
    assert wf.rules.evaluate_rules(rules, "any", SCOPE) is True
    assert wf.rules.evaluate_rules(rules, "all", SCOPE) is False
    assert wf.rules.evaluate_rules([], "all", SCOPE) is True


# -- branching nodes, run directly ---------------------------------------------


def _ctx(wf, node, *, iteration=1):
    base = wf.nodes_base
    return base.NodeContext(
        node_id=node.id,
        execution_id=f"{node.id}#{iteration}",
        iteration=iteration,
        parent_execution_id=None,
        run=base.RunInfo("r1", "t1", "u1", "w1", 1),
        config=node.config,
        scope=SCOPE,
        emitter=None,
        writer=None,
    )


def _node(wf, kind, config):
    spec = wf.spec.WorkflowSpec.model_validate(_minimal())
    node_spec = wf.spec.NodeSpec(id="n", kind=kind, config=config)
    return wf.nodes.NODE_KINDS[kind](node_spec, spec)


@pytest.mark.asyncio
async def test_condition_branches(wf):
    node = _node(wf, "condition", {"rules": [{"path": "input.n", "op": "gt", "value": 2}]})
    result = await node.run({}, _ctx(wf, node))
    assert (result.branch, result.output) == ("true", {"result": True})
    node = _node(wf, "condition", {"mode": "any", "rules": [{"path": "input.n", "op": "gt", "value": 5}]})
    assert (await node.run({}, _ctx(wf, node))).branch == "false"


@pytest.mark.asyncio
async def test_router_takes_the_first_matching_case_else_default(wf):
    config = {
        "cases": [
            {"name": "small", "rules": [{"path": "input.n", "op": "lt", "value": 2}]},
            {"name": "three", "rules": [{"path": "input.n", "op": "eq", "value": 3}]},
            {"name": "also_three", "rules": [{"path": "input.n", "op": "gte", "value": 3}]},
        ]
    }
    node = _node(wf, "router", config)
    assert node.branch_names() == ("small", "three", "also_three", "default")
    assert (await node.run({}, _ctx(wf, node))).branch == "three"
    config["cases"] = config["cases"][:1]
    node = _node(wf, "router", config)
    result = await node.run({}, _ctx(wf, node))
    assert (result.branch, result.output) == ("default", {"case": "default"})


@pytest.mark.asyncio
async def test_loop_continues_up_to_max_iterations_while_its_rules_hold(wf):
    node = _node(wf, "loop", {"max_iterations": 2})
    branches = [(await node.run({}, _ctx(wf, node, iteration=n))).branch for n in (1, 2, 3)]
    assert branches == ["continue", "continue", "done"]
    node = _node(wf, "loop", {"max_iterations": 5, "while": [{"path": "input.n", "op": "lt", "value": 3}]})
    assert (await node.run({}, _ctx(wf, node))).branch == "done"
    assert node.config.max_iterations == 5 and len(node.config.while_) == 1


def test_loop_stack_push_replace_pop(wf):
    node = _node(wf, "loop", {})
    base = wf.nodes_base
    cont, done = base.NodeResult(branch="continue"), base.NodeResult(branch="done")
    assert node.next_loops([], cont, "n#1") == ["n#1"]
    assert node.next_loops(["outer#1", "n#1", "inner#2"], cont, "n#2") == ["outer#1", "n#2"]
    assert node.next_loops(["outer#1", "n#2"], done, "n#3") == ["outer#1"]


def test_reads_and_writes_are_declared(wf):
    spec = wf.spec.WorkflowSpec.model_validate(_example())
    poll = wf.nodes.NODE_KINDS["fetch"](spec.node("poll"), spec)
    assert poll.reads() == ["input.job_url", "input.token"]
    assert poll.writes() == ["nodes.poll.output", "state.history", "state.last_status"]
    ready = wf.nodes.NODE_KINDS["condition"](spec.node("is_ready"), spec)
    assert ready.reads() == ["nodes.poll.output.body.status", "nodes.poll.output.status"]


def test_catalog_lists_every_kind_with_a_json_schema(wf):
    catalog = {entry["kind"]: entry for entry in wf.catalog.node_catalog()}
    assert set(catalog) == {
        "trigger.manual", "trigger.schedule", "tool", "fetch", "condition", "router", "loop", "approval", "end",
    }
    assert catalog["condition"]["branches"] == ["true", "false"]
    assert catalog["router"]["dynamicBranches"] is True
    assert catalog["trigger.manual"]["isTrigger"] is True
    assert "while" in catalog["loop"]["configSchema"]["properties"]
    assert catalog["fetch"]["configSchema"]["properties"]["timeout_seconds"]["maximum"] == 30
    for entry in catalog.values():
        assert entry["configSchema"]["additionalProperties"] is False
        assert "assign" in entry["configSchema"]["properties"]
