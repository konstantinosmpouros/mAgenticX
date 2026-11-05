"""``loop`` — a bounded back-edge.

A loop node sits at the head of a cycle. On its n-th execution it takes the
``continue`` branch while ``n <= max_iterations`` and its ``while`` rules hold
(no rules = always), and ``done`` otherwise — so the body runs at most
``max_iterations`` times and the cycle always ends. The validator allows a
cycle only through a loop's ``continue`` edge.

Executions inside an iteration get this loop's execution as their
``parentExecutionId``: ``continue`` pushes (or, on re-entry, replaces) it on the
run's loop stack and ``done`` pops it.

Output: ``{"iteration": n, "continue": bool}``.

The counter is per run, not per entry: a loop nested in another loop's body
does not restart its count on the outer loop's next iteration (v1 limit).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import ConfigDict, Field

from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode
from harness.workflows.rules import MAX_RULES, MatchMode, Rule, evaluate_rules

DEFAULT_MAX_ITERATIONS = 5
MAX_ITERATIONS_CAP = 20


class LoopConfig(NodeConfig):
    """The iteration cap and the keep-going condition."""

    max_iterations: int = Field(default=DEFAULT_MAX_ITERATIONS, ge=1, le=MAX_ITERATIONS_CAP)
    mode: MatchMode = "all"
    while_: list[Rule] = Field(
        default_factory=list,
        max_length=MAX_RULES,
        alias="while",
        description="Keep looping while these rules hold (empty = until max_iterations)",
    )

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class LoopNode(WorkflowNode):
    """Bounded loop head."""

    kind = "loop"
    label = "Loop"
    group = "flow"
    description = "Repeats its 'continue' branch up to max_iterations times while its rules hold, then takes 'done'."
    Config = LoopConfig
    branches = ("continue", "done")

    def rule_paths(self) -> list[str]:
        return [rule.path for rule in self.config.while_]

    def next_loops(self, loops: list[str], result: NodeResult, execution_id: str) -> list[str]:
        # Drop this loop's previous iteration — and any inner loop frames still
        # above it — then push this execution while the loop goes on.
        mine = next((i for i, entry in enumerate(loops) if entry.split("#", 1)[0] == self.id), None)
        base = loops[:mine] if mine is not None else loops
        return [*base, execution_id] if result.branch == "continue" else base

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        within_cap = ctx.iteration <= ctx.config.max_iterations
        keep_going = within_cap and evaluate_rules(ctx.config.while_, ctx.config.mode, ctx.scope)
        return NodeResult(
            output={"iteration": ctx.iteration, "continue": keep_going},
            branch="continue" if keep_going else "done",
        )
