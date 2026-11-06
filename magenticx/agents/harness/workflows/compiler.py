"""Compile a validated ``WorkflowSpec`` into a LangGraph ``StateGraph``.

One graph node per spec node — the node instance's wrapper
(``WorkflowNode.__call__``) is what runs. ``START`` leads to the trigger. A
branching node gets a conditional edge that reads the branch it recorded in
``state["nodes"][id]["branch"]``; a branch with no edge, or a node with no
outgoing edge, ends the run. A node with several plain edges starts every
target at once (parallel paths, one LangGraph superstep); the edges into a
``join`` become one barrier edge, so it runs once, after every path arrived. The graph is compiled against a checkpointer — in
the service the process-wide durable ``AsyncPostgresSaver``, so an ``approval``
pause survives a restart exactly like an agent's HITL pause.

Compiled graphs are cached by ``(workflow_id, version_no)``: a version is
immutable, so its graph is too. The cache is bounded (LRU) and keyed on the
checkpointer it was compiled with, so a different saver recompiles.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from harness.workflows.errors import WorkflowSpecInvalid
from harness.workflows.nodes import WorkflowNode
from harness.workflows.nodes.join import JoinNode
from harness.workflows.nodes.loop import LoopNode
from harness.workflows.spec import WorkflowSpec
from harness.workflows.state import build_state_type
from harness.workflows.validator import build_node_instances, validate_spec

#: Headroom over the computed step bound (LangGraph counts supersteps).
RECURSION_HEADROOM = 10
MAX_RECURSION_LIMIT = 2000
COMPILE_CACHE_SIZE = 64


@dataclass(frozen=True)
class CompiledWorkflow:
    """A runnable workflow: the compiled graph plus what the runner needs."""

    graph: Any
    spec: WorkflowSpec
    nodes: dict[str, WorkflowNode]
    recursion_limit: int


def recursion_limit_for(spec: WorkflowSpec, nodes: dict[str, WorkflowNode]) -> int:
    """An upper bound on supersteps: every node once, plus every node again per
    loop iteration any loop may grant. Cycles only exist through loops, so a
    correct run can never exceed it — hitting it means a bug, and stops the run."""
    loop_budget = sum(n.config.max_iterations for n in nodes.values() if isinstance(n, LoopNode))
    bound = len(spec.nodes) * (1 + loop_budget) + RECURSION_HEADROOM
    return min(bound, MAX_RECURSION_LIMIT)


def _node_callable(instance: WorkflowNode):
    """A plain coroutine function for LangGraph (it inspects the signature)."""

    async def run_node(state: dict, config: RunnableConfig) -> dict:
        return await instance(state, config)

    run_node.__name__ = f"workflow_node_{instance.id}"
    return run_node


def _router(node_id: str, targets: dict[str, str]):
    """The conditional edge of a branching node: its recorded branch → target."""

    def route(state: dict) -> str:
        branch = ((state.get("nodes") or {}).get(node_id) or {}).get("branch")
        return targets.get(branch, END)

    return route


def compile_workflow(spec: WorkflowSpec, *, checkpointer: Any) -> CompiledWorkflow:
    """Build and compile the graph. The spec is re-validated: compiling an
    invalid spec is a bug upstream, and must not produce a half-wired graph."""
    _, issues = validate_spec(spec.model_dump(mode="json"))
    if issues:
        raise WorkflowSpecInvalid("; ".join(issue.message for issue in issues))
    nodes = build_node_instances(spec)
    graph = StateGraph(build_state_type(spec))
    for node_id, instance in nodes.items():
        graph.add_node(node_id, _node_callable(instance))

    trigger = next(node_id for node_id, instance in nodes.items() if instance.is_trigger)
    graph.add_edge(START, trigger)

    branch_targets: dict[str, dict[str, str]] = {node_id: {} for node_id in nodes}
    plain_targets: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    join_sources: dict[str, list[str]] = {node_id: [] for node_id, n in nodes.items() if isinstance(n, JoinNode)}
    for edge in spec.edges:
        if edge.branch is not None:
            branch_targets[edge.source][edge.branch] = edge.target
        elif edge.target in join_sources:
            join_sources[edge.target].append(edge.source)
        else:
            plain_targets[edge.source].append(edge.target)
    for node_id, instance in nodes.items():
        if instance.branch_names():
            targets = branch_targets[node_id]
            destinations = [*sorted(set(targets.values())), END]
            graph.add_conditional_edges(node_id, _router(node_id, targets), destinations)
            continue
        # Several plain edges: every target starts in the next superstep, in
        # parallel. Edges into a join are wired below, as its barrier.
        for target in plain_targets[node_id]:
            graph.add_edge(node_id, target)
        leads_to_join = any(node_id in sources for sources in join_sources.values())
        if not plain_targets[node_id] and not leads_to_join:
            graph.add_edge(node_id, END)
    # "Wait for all": one barrier edge from every path's last step, so the join
    # runs once, after the last of them (and again on a loop's next pass).
    for join_id, sources in join_sources.items():
        graph.add_edge(sources, join_id)

    return CompiledWorkflow(
        graph=graph.compile(checkpointer=checkpointer),
        spec=spec,
        nodes=nodes,
        recursion_limit=recursion_limit_for(spec, nodes),
    )


_CACHE: OrderedDict[tuple[str, int], tuple[int, CompiledWorkflow]] = OrderedDict()


def get_compiled(workflow_id: str, version_no: int, spec: WorkflowSpec, *, checkpointer: Any) -> CompiledWorkflow:
    """The compiled graph of one workflow version, from the LRU cache or fresh."""
    key = (workflow_id, version_no)
    cached = _CACHE.get(key)
    if cached is not None and cached[0] == id(checkpointer):
        _CACHE.move_to_end(key)
        return cached[1]
    compiled = compile_workflow(spec, checkpointer=checkpointer)
    _CACHE[key] = (id(checkpointer), compiled)
    _CACHE.move_to_end(key)
    while len(_CACHE) > COMPILE_CACHE_SIZE:
        _CACHE.popitem(last=False)
    return compiled


def forget_compiled(workflow_id: str) -> None:
    """Drop every cached version of a workflow (it was deleted)."""
    for key in [k for k in _CACHE if k[0] == workflow_id]:
        _CACHE.pop(key, None)


__all__ = [
    "CompiledWorkflow",
    "compile_workflow",
    "forget_compiled",
    "get_compiled",
    "recursion_limit_for",
]
