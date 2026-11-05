"""``condition`` — branch ``true`` / ``false`` on structured rules.

``rules`` are ``{path, op, value}`` triples (``harness/workflows/rules.py``)
combined with ``mode`` ``all`` or ``any``. Output: ``{"result": bool}``.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import Field

from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode
from harness.workflows.rules import MAX_RULES, MatchMode, Rule, evaluate_rules


class ConditionConfig(NodeConfig):
    """The rules and how they combine."""

    mode: MatchMode = Field(default="all", description="all = every rule must hold; any = at least one")
    rules: list[Rule] = Field(min_length=1, max_length=MAX_RULES)


class ConditionNode(WorkflowNode):
    """Two-way branch."""

    kind = "condition"
    label = "Condition"
    group = "flow"
    description = "Takes the 'true' or 'false' branch depending on rules over the run's data."
    Config = ConditionConfig
    branches = ("true", "false")

    def rule_paths(self) -> list[str]:
        return [rule.path for rule in self.config.rules]

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        result = evaluate_rules(ctx.config.rules, ctx.config.mode, ctx.scope)
        return NodeResult(output={"result": result}, branch="true" if result else "false")
