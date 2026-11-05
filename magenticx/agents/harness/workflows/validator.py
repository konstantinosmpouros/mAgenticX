"""Validate a raw workflow spec into a ``WorkflowSpec`` plus node-addressed issues.

Every save, every ``/validate`` and every compile runs this; the builder is
never the authority. It reports **every** problem it can find in one pass so
the builder can mark each node at once, each as ``{node_id, path, message}``
(``node_id`` ``None`` for a workflow-level problem).

Checks, in order (a later stage runs only when the earlier ones leave
something to check):

1. Size: ≤ 256 KiB of JSON and ≤ 50 nodes — before anything is parsed.
2. Shape: the Pydantic models (unknown keys refused everywhere).
3. Names: unique node/edge/input/state names; none reserved; no node id that
   equals a state name (LangGraph channels and nodes share a namespace);
   reducers that fit their types; defaults that match their types.
4. Nodes: a known kind, a valid ``config`` for it, the kind's own checks.
5. Graph: exactly one trigger (``trigger.manual`` or ``trigger.schedule``); edges between existing nodes; nothing into the
   trigger; nothing out of an ``end``; a branch label exactly when the source
   branches, one of its branches, at most one edge per (source, branch) — a
   workflow runs one path at a time; every node reachable from the trigger; no
   cycle except through a ``loop`` node's ``continue`` edge.
6. References: every template and rule path names an existing input, state
   field or node; ``assign`` writes only declared state fields.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from harness.workflows.errors import TemplateError
from harness.workflows.nodes import NODE_KINDS, ValidationContext, WorkflowNode
from harness.workflows.nodes.end import EndNode
from harness.workflows.nodes.loop import LoopNode
from harness.workflows.spec import (
    MAX_NODES,
    MAX_SPEC_BYTES,
    RESERVED_NAMES,
    WorkflowSpec,
    spec_size_bytes,
    type_matches,
)


@dataclass(frozen=True)
class ValidationIssue:
    """One problem, pinned to a node (or the workflow) and a path in the spec."""

    node_id: str | None
    path: str
    message: str

    def as_dict(self) -> dict[str, Any]:
        return {"nodeId": self.node_id, "path": self.path, "message": self.message}


def _loc_path(prefix: str, loc: Iterable[Any]) -> str:
    """``("nodes", 3, "id")`` → ``nodes[3].id``."""
    path = prefix
    for part in loc:
        if isinstance(part, int):
            path += f"[{part}]"
        else:
            path += f".{part}" if path else str(part)
    return path


def _raw_node_id(raw: Any, index: Any) -> str | None:
    """The id the raw document gives node ``index``, if it gives a usable one."""
    try:
        value = raw["nodes"][index]["id"]
    except (KeyError, IndexError, TypeError):
        return None
    return value if isinstance(value, str) else None


def _shape_issues(raw: Any, exc: ValidationError) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for err in exc.errors():
        loc = tuple(err.get("loc", ()))
        node_id = _raw_node_id(raw, loc[1]) if len(loc) > 1 and loc[0] == "nodes" else None
        issues.append(ValidationIssue(node_id, _loc_path("", loc) or "$", err.get("msg", "Invalid value.")))
    return issues


def validate_spec(
    raw: Any, *, known_mcp_tools: frozenset[str] | None = None
) -> tuple[WorkflowSpec | None, list[ValidationIssue]]:
    """``(spec, [])`` for a valid workflow, else ``(None, issues)``.

    ``known_mcp_tools`` is the gateway catalogue's tool names; ``None`` means
    it could not be read, and MCP tool references are then not checked here
    (they still fail at run time if missing).
    """
    if not isinstance(raw, dict):
        return None, [ValidationIssue(None, "$", "The workflow must be a JSON object.")]
    if spec_size_bytes(raw) > MAX_SPEC_BYTES:
        return None, [ValidationIssue(None, "$", f"The workflow is larger than {MAX_SPEC_BYTES // 1024} KiB.")]
    nodes_raw = raw.get("nodes")
    if isinstance(nodes_raw, list) and len(nodes_raw) > MAX_NODES:
        return None, [ValidationIssue(None, "nodes", f"A workflow has at most {MAX_NODES} nodes.")]

    try:
        spec = WorkflowSpec.model_validate(raw)
    except ValidationError as exc:
        return None, _shape_issues(raw, exc)

    issues = _name_issues(spec)
    instances, node_issues = _build_nodes(spec, ValidationContext(known_mcp_tools=known_mcp_tools))
    issues += node_issues
    issues += _graph_issues(spec, instances)
    issues += _reference_issues(spec, instances)
    return (None, issues) if issues else (spec, [])


def build_node_instances(spec: WorkflowSpec) -> dict[str, WorkflowNode]:
    """Instantiate every node of an already-valid spec (the compiler's entry)."""
    instances, issues = _build_nodes(spec, ValidationContext())
    if issues:
        raise ValueError("; ".join(issue.message for issue in issues))
    return instances


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------
def _duplicates(values: Iterable[str]) -> set[str]:
    seen: set[str] = set()
    dupes: set[str] = set()
    for value in values:
        (dupes if value in seen else seen).add(value)
    return dupes


def _name_issues(spec: WorkflowSpec) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for dupe in _duplicates(n.id for n in spec.nodes):
        issues.append(ValidationIssue(dupe, "nodes", f"Node id '{dupe}' is used more than once."))
    for dupe in _duplicates(e.id for e in spec.edges):
        issues.append(ValidationIssue(None, "edges", f"Edge id '{dupe}' is used more than once."))
    for dupe in _duplicates(i.name for i in spec.inputs):
        issues.append(ValidationIssue(None, "inputs", f"Input '{dupe}' is declared more than once."))
    for dupe in _duplicates(f.name for f in spec.state):
        issues.append(ValidationIssue(None, "state", f"State field '{dupe}' is declared more than once."))

    state_names = {f.name for f in spec.state}
    for index, field in enumerate(spec.state):
        path = f"state[{index}]"
        if field.name in RESERVED_NAMES:
            issues.append(ValidationIssue(None, f"{path}.name", f"'{field.name}' is reserved."))
        if field.reducer == "append" and field.type != "array":
            issues.append(ValidationIssue(None, f"{path}.reducer", "The append reducer needs an array field."))
        if field.reducer == "merge" and field.type != "object":
            issues.append(ValidationIssue(None, f"{path}.reducer", "The merge reducer needs an object field."))
        if field.default is not None and not type_matches(field.type, field.default):
            issues.append(ValidationIssue(None, f"{path}.default", f"The default must be of type {field.type}."))
    for index, item in enumerate(spec.inputs):
        if item.default is not None and not type_matches(item.type, item.default):
            issues.append(ValidationIssue(None, f"inputs[{index}].default", f"The default must be of type {item.type}."))
    for index, node in enumerate(spec.nodes):
        if node.id in RESERVED_NAMES or node.id in state_names:
            issues.append(
                ValidationIssue(node.id, f"nodes[{index}].id", f"Node id '{node.id}' clashes with a state name.")
            )
    return issues


def _build_nodes(
    spec: WorkflowSpec, vctx: ValidationContext
) -> tuple[dict[str, WorkflowNode], list[ValidationIssue]]:
    instances: dict[str, WorkflowNode] = {}
    issues: list[ValidationIssue] = []
    for index, node in enumerate(spec.nodes):
        cls = NODE_KINDS.get(node.kind)
        if cls is None:
            issues.append(ValidationIssue(node.id, f"nodes[{index}].kind", f"Unknown node kind '{node.kind}'."))
            continue
        try:
            instance = cls(node, spec)
        except ValidationError as exc:
            for err in exc.errors():
                path = _loc_path(f"nodes[{index}].config", err.get("loc", ()))
                issues.append(ValidationIssue(node.id, path, err.get("msg", "Invalid value.")))
            continue
        for path, message in instance.validate_semantics(vctx):
            issues.append(ValidationIssue(node.id, f"nodes[{index}].config.{path}", message))
        instances.setdefault(node.id, instance)
    return instances, issues


def _graph_issues(spec: WorkflowSpec, instances: dict[str, WorkflowNode]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    node_ids = {n.id for n in spec.nodes}
    # By kind, not by instance: a trigger whose config is invalid is still the
    # workflow's one trigger (its config issue is reported on the node).
    triggers = [n.id for n in spec.nodes if (cls := NODE_KINDS.get(n.kind)) is not None and cls.is_trigger]
    if len(triggers) != 1:
        issues.append(
            ValidationIssue(
                None,
                "nodes",
                f"A workflow needs exactly one trigger node ({', '.join(_trigger_kinds())}); found {len(triggers)}.",
            )
        )

    adjacency: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    used: set[tuple[str, str | None]] = set()
    for index, edge in enumerate(spec.edges):
        path = f"edges[{index}]"
        if edge.source not in node_ids:
            issues.append(ValidationIssue(None, f"{path}.source", f"Edge source '{edge.source}' is not a node."))
            continue
        if edge.target not in node_ids:
            issues.append(ValidationIssue(edge.source, f"{path}.target", f"Edge target '{edge.target}' is not a node."))
            continue
        # Recorded before the source's own checks: a node whose config is
        # invalid still connects the graph, so what follows it is not also
        # reported unreachable.
        adjacency[edge.source].append((edge.target, edge.branch))
        source = instances.get(edge.source)
        target = instances.get(edge.target)
        if target is not None and target.is_trigger:
            issues.append(ValidationIssue(edge.target, f"{path}.target", "Nothing may lead into the trigger."))
        if source is None:
            continue  # its own issue is already reported
        if isinstance(source, EndNode):
            issues.append(ValidationIssue(edge.source, path, "An end node has no outgoing edges."))
        branches = source.branch_names()
        if branches and edge.branch is None:
            issues.append(
                ValidationIssue(edge.source, f"{path}.branch", f"Edges from '{edge.source}' need a branch: {', '.join(branches)}.")
            )
        elif not branches and edge.branch is not None:
            issues.append(ValidationIssue(edge.source, f"{path}.branch", f"'{edge.source}' does not branch."))
        elif edge.branch is not None and edge.branch not in branches:
            issues.append(
                ValidationIssue(edge.source, f"{path}.branch", f"Unknown branch '{edge.branch}' (expected: {', '.join(branches)}).")
            )
        key = (edge.source, edge.branch)
        if key in used:
            label = f"branch '{edge.branch}'" if edge.branch else "an outgoing edge"
            issues.append(
                ValidationIssue(edge.source, path, f"'{edge.source}' already has {label}; a workflow runs one path at a time.")
            )
        used.add(key)

    for node_id, instance in instances.items():
        if isinstance(instance, LoopNode) and (node_id, "continue") not in used:
            issues.append(ValidationIssue(node_id, "edges", "A loop needs a 'continue' edge."))

    if len(triggers) == 1:
        reachable = _reachable(triggers[0], adjacency)
        for node in spec.nodes:
            if node.id not in reachable:
                issues.append(ValidationIssue(node.id, "nodes", f"Node '{node.id}' is not reachable from the trigger."))

    loops = {n.id for n in spec.nodes if NODE_KINDS.get(n.kind) is LoopNode}
    cycle = _find_cycle(node_ids, adjacency, loops)
    if cycle:
        issues.append(
            ValidationIssue(
                cycle[0],
                "edges",
                f"Cycle {' -> '.join(cycle)} does not go through a loop's 'continue' edge.",
            )
        )
    return issues


def _trigger_kinds() -> list[str]:
    """The catalogue's trigger kinds, for the "one trigger" message."""
    return [kind for kind, cls in NODE_KINDS.items() if cls.is_trigger]


def _reachable(start: str, adjacency: dict[str, list[tuple[str, str | None]]]) -> set[str]:
    seen = {start}
    stack = [start]
    while stack:
        for target, _branch in adjacency.get(stack.pop(), []):
            if target not in seen:
                seen.add(target)
                stack.append(target)
    return seen


def _find_cycle(
    node_ids: set[str],
    adjacency: dict[str, list[tuple[str, str | None]]],
    loops: set[str],
) -> list[str] | None:
    """A cycle left once every loop's ``continue`` edge is removed, if any.

    Removing those edges must leave a DAG: then every cycle passes through a
    loop's ``continue``, and the loop's iteration cap bounds the run.
    """
    def edges(node: str) -> list[str]:
        is_loop = node in loops  # by kind, so a loop with a bad config still counts
        return [t for t, b in adjacency.get(node, []) if not (is_loop and b == "continue")]

    state: dict[str, int] = {}  # 1 = on stack, 2 = done
    path: list[str] = []

    def visit(node: str) -> list[str] | None:
        state[node] = 1
        path.append(node)
        for nxt in edges(node):
            if state.get(nxt) == 1:
                return [*path[path.index(nxt):], nxt]
            if nxt not in state:
                found = visit(nxt)
                if found:
                    return found
        path.pop()
        state[node] = 2
        return None

    for node in sorted(node_ids):
        if node not in state:
            found = visit(node)
            if found:
                return found
    return None


def _reference_issues(spec: WorkflowSpec, instances: dict[str, WorkflowNode]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    inputs = {i.name for i in spec.inputs}
    fields = {f.name for f in spec.state}
    node_ids = {n.id for n in spec.nodes}
    index_of = {n.id: i for i, n in enumerate(spec.nodes)}

    def check(node_id: str, refs_of, where: str) -> None:
        try:
            refs = refs_of()
        except TemplateError as exc:
            issues.append(ValidationIssue(node_id, where, str(exc)))
            return
        for ref in refs:
            if ref.root == "input" and ref.name not in inputs:
                issues.append(ValidationIssue(node_id, where, f"'{ref.text}' reads an undeclared input '{ref.name}'."))
            elif ref.root == "state" and ref.name not in fields:
                issues.append(ValidationIssue(node_id, where, f"'{ref.text}' reads an undeclared state field '{ref.name}'."))
            elif ref.root == "nodes" and ref.node_id not in node_ids:
                issues.append(ValidationIssue(node_id, where, f"'{ref.text}' reads an unknown node '{ref.node_id}'."))

    for node_id, instance in instances.items():
        base = f"nodes[{index_of[node_id]}].config"
        check(node_id, instance.references, base)
        check(node_id, instance.assign_references, f"{base}.assign")
        for name in instance.config.assign:
            if name not in fields:
                issues.append(
                    ValidationIssue(node_id, f"{base}.assign.{name}", f"'{name}' is not a declared state field.")
                )
    return issues


__all__ = ["ValidationIssue", "build_node_instances", "validate_spec"]
