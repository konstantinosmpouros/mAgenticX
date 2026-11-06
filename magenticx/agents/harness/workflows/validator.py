"""Validate a raw workflow spec into a ``WorkflowSpec`` plus node-addressed issues.

Every save, every ``/validate`` and every compile runs this; the builder is
never the authority. It reports **every** problem it can find in one pass so
the builder can mark each node at once, each as ``{node_id, path, message}``
(``node_id`` ``None`` for a workflow-level problem).

Checks, in order (a later stage runs only when the earlier ones leave
something to check):

1. Size: ≤ 256 KiB of JSON and ≤ 50 nodes — before anything is parsed.
2. Shape: the Pydantic models (unknown keys refused everywhere).
3. Names: unique node/edge/input names; no node id that is reserved (LangGraph
   channels and nodes share a namespace); input defaults that match their types.
4. Nodes: a known kind this deployment can run (``availability()`` — e.g.
   ``code`` needs the sandbox runner), a valid ``config`` for it, the kind's
   own checks.
5. Graph: exactly one trigger (``trigger.manual`` or ``trigger.schedule``); edges between existing nodes; nothing into the
   trigger; nothing out of an ``end``; a branch label exactly when the source
   branches, one of its branches, at most one edge per (source, branch);
   several plain edges from one node start parallel paths, which must meet at
   one ``join`` (``_parallel_issues``); every node reachable from the trigger;
   no cycle except through a ``loop`` node's ``continue`` edge.
6. References: every template and rule path names an existing input,
   variable (a name some ``set`` step writes — readable from every step, since
   it may hold the previous run's kept value) or node.
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
from harness.workflows.nodes.join import JoinNode
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
    instances, node_issues = _build_nodes(
        spec, ValidationContext(known_mcp_tools=known_mcp_tools), check_availability=True
    )
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
    for index, item in enumerate(spec.inputs):
        if item.default is not None and not type_matches(item.type, item.default):
            issues.append(ValidationIssue(None, f"inputs[{index}].default", f"The default must be of type {item.type}."))
    for index, node in enumerate(spec.nodes):
        if node.id in RESERVED_NAMES:
            issues.append(
                ValidationIssue(node.id, f"nodes[{index}].id", f"Id '{node.id}' is reserved.")
            )
    return issues


def _build_nodes(
    spec: WorkflowSpec, vctx: ValidationContext, *, check_availability: bool = False
) -> tuple[dict[str, WorkflowNode], list[ValidationIssue]]:
    """Instantiate every node, collecting config and kind-specific issues.

    ``check_availability`` refuses a kind this deployment cannot run (``code``
    without a sandbox runner). It is on for :func:`validate_spec` — every save,
    ``/validate`` and run start — and off for the compiler's own instantiation,
    which only ever sees a spec that has just passed :func:`validate_spec`.
    """
    instances: dict[str, WorkflowNode] = {}
    issues: list[ValidationIssue] = []
    for index, node in enumerate(spec.nodes):
        cls = NODE_KINDS.get(node.kind)
        if cls is None:
            issues.append(ValidationIssue(node.id, f"nodes[{index}].kind", f"Unknown node kind '{node.kind}'."))
            continue
        if check_availability:
            available, reason = cls.availability()
            if not available:
                message = reason or f"'{node.kind}' steps are not available on this deployment."
                issues.append(ValidationIssue(node.id, f"nodes[{index}].kind", message))
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
    plain_pairs: set[tuple[str, str]] = set()
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
        # A branch leads to one step. Plain edges may be several: they start
        # parallel paths (checked by ``_parallel_issues``), but never the same
        # target twice.
        key = (edge.source, edge.branch)
        if edge.branch is not None and key in used:
            issues.append(
                ValidationIssue(edge.source, path, f"'{edge.source}' already has branch '{edge.branch}'; a branch leads to one step.")
            )
        elif edge.branch is None and (edge.source, edge.target) in plain_pairs:
            issues.append(ValidationIssue(edge.source, path, f"'{edge.source}' is already connected to '{edge.target}'."))
        used.add(key)
        if edge.branch is None:
            plain_pairs.add((edge.source, edge.target))

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
    else:
        issues += _parallel_issues(spec)
    return issues


def _parallel_issues(spec: WorkflowSpec) -> list[ValidationIssue]:
    """Parallel paths must be safe to wait for.

    A step with two or more plain outgoing edges (a *fork*) starts each target
    at once. From each target a *path* runs to one ``join`` ("Wait for all"),
    which the compiler wires as a barrier: it runs once every path has
    arrived. So every path must be sure to arrive, exactly once:

    * a path is a straight chain — each step on it is reached only from the
      path, has one plain outgoing edge, does not branch (no condition, router,
      loop or approval) and is not an end;
    * no fork inside a path (nested parallel paths are not supported yet);
    * every path of a fork ends at the same join, which nothing else leads into;
    * a join closes exactly one fork's paths.

    Runs only on an acyclic-but-for-loops graph (the cycle check passed), and
    walks only well-formed edges.
    """
    issues: list[ValidationIssue] = []
    kinds = {n.id: NODE_KINDS.get(n.kind) for n in spec.nodes}
    plain_out: dict[str, list[str]] = defaultdict(list)
    incoming: dict[str, list[str]] = defaultdict(list)
    for edge in spec.edges:
        if edge.source not in kinds or edge.target not in kinds:
            continue
        incoming[edge.target].append(edge.source)
        if edge.branch is None:
            plain_out[edge.source].append(edge.target)

    def is_join(node_id: str) -> bool:
        return kinds.get(node_id) is JoinNode

    def step_problem(node_id: str) -> str | None:
        cls = kinds.get(node_id)
        if cls is None:
            return ""  # unknown kind: already reported on the node
        if cls.branches or cls.dynamic_branches:
            return (
                "A step on a parallel path can't branch (condition, router, loop or approval). "
                "Put it before the paths split or after 'Wait for all'."
            )
        if cls is EndNode:
            return "Parallel paths must meet at a 'Wait for all' step before the end."
        if len(incoming[node_id]) != 1:
            return "A step on a parallel path can only be reached from that path."
        if len(plain_out[node_id]) > 1:
            return "A parallel path can't split again (nested parallel paths are not supported yet)."
        if not plain_out[node_id]:
            return "This parallel path stops here; lead it into a 'Wait for all' step."
        return None

    closed: set[str] = set()
    for fork, targets in list(plain_out.items()):
        cls = kinds.get(fork)
        if len(targets) < 2 or cls is None or cls.branches or cls.dynamic_branches:
            continue  # a branching step's plain edges are already an error
        joins: set[str] = set()
        ends: list[str] = []
        complete = True
        for target in targets:
            node, previous, seen = target, fork, set()
            while not is_join(node):
                problem = step_problem(node)
                if problem is not None or node in seen:
                    if problem:
                        issues.append(ValidationIssue(node, "edges", problem))
                    complete = False
                    break
                seen.add(node)
                previous, node = node, plain_out[node][0]
            else:
                if previous == fork:
                    issues.append(
                        ValidationIssue(fork, "edges", "Each parallel path needs at least one step before 'Wait for all'.")
                    )
                    complete = False
                joins.add(node)
                ends.append(previous)
        if not complete:
            continue
        if len(joins) != 1:
            issues.append(
                ValidationIssue(fork, "edges", "The parallel paths that start here must all end at the same 'Wait for all' step.")
            )
            continue
        join = joins.pop()
        if sorted(incoming[join]) != sorted(ends):
            issues.append(
                ValidationIssue(join, "edges", "Only the parallel paths that start at one step may lead into this 'Wait for all'.")
            )
        closed.add(join)

    # Only when the paths themselves are fine: a broken path already explains
    # why its join is not closed.
    for node in spec.nodes if not issues else ():
        if is_join(node.id) and node.id not in closed:
            issues.append(
                ValidationIssue(
                    node.id,
                    "edges",
                    "'Wait for all' joins parallel paths: connect one step to two or more steps, "
                    "and lead each of those paths here.",
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
    variables = set(spec.variables())
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
            elif ref.root == "state" and ref.name not in variables:
                issues.append(ValidationIssue(node_id, where, f"'{ref.name}' is not a variable: no Set step writes it."))
            elif ref.root == "nodes" and ref.node_id not in node_ids:
                issues.append(ValidationIssue(node_id, where, f"'{ref.text}' reads an unknown node '{ref.node_id}'."))

    for node_id, instance in instances.items():
        base = f"nodes[{index_of[node_id]}].config"
        check(node_id, instance.references, base)
    return issues


__all__ = ["ValidationIssue", "build_node_instances", "validate_spec"]
