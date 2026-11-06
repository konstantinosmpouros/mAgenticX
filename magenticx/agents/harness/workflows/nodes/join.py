"""``join`` — "Wait for all": where parallel paths meet again.

A step with two or more plain outgoing connections starts every target at
once — each target begins a *parallel path*. The paths must all lead into one
``join``; the compiler wires its incoming connections as a LangGraph barrier
(``add_edge([ends…], join)``), so the join runs **once**, after the last path
arrives, and the run continues from it alone. Inside a loop the barrier resets
after each pass. The validator keeps the structure simple enough for that to
be safe (``validator._parallel_issues``): a path is a straight chain of steps
that do not branch, so every path is sure to arrive.

Paths advance in lockstep: LangGraph runs a superstep's tasks concurrently and
starts the next superstep when all of them are done, so the N-th steps of all
paths run together and a path's next step waits for the slowest N-th step.

Output: ``{<step id>: <its answer>}`` — the result of the last step on each
path, through that kind's ``context_value`` (an ``llm`` step gives its answer,
not its conversation). A step after the join therefore sees every path's result
as its "previous step" context.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from harness.workflows import nodes as node_catalog
from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode


class JoinNode(WorkflowNode):
    """Barrier where parallel paths meet."""

    kind = "join"
    label = "Wait for all"
    group = "flow"
    description = "Waits until every parallel path has finished, then continues once with all their results."
    Config = NodeConfig

    def sources(self) -> list[str]:
        """The steps that lead into this one (each path's last step), in spec order."""
        return [edge.source for edge in self.spec.edges if edge.target == self.id]

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        records = state.get("nodes") or {}
        results: dict[str, Any] = {}
        for source in self.sources():
            node = self.spec.node(source)
            cls = node_catalog.node_class(node.kind) if node is not None else None
            output = (records.get(source) or {}).get("output")
            results[source] = cls.context_value(output) if cls is not None else output
        return NodeResult(output=results)
