"""``router`` — pick the first matching case's branch, else ``default``.

Each case is a named rule set; cases are tried in order and the first that
holds names the branch. The case names *are* the branch names, so they are
validated like branch names and may not be ``default``.
Output: ``{"case": <name>}``.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode
from harness.workflows.rules import MAX_RULES, MatchMode, Rule, evaluate_rules
from harness.workflows.spec import BRANCH_PATTERN

MAX_CASES = 16
DEFAULT_BRANCH = "default"


class RouterCase(BaseModel):
    """One named case."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=BRANCH_PATTERN, description="Branch name taken when this case matches")
    mode: MatchMode = "all"
    rules: list[Rule] = Field(min_length=1, max_length=MAX_RULES)


class RouterConfig(NodeConfig):
    """Ordered cases; the first match wins."""

    cases: list[RouterCase] = Field(min_length=1, max_length=MAX_CASES)


class RouterNode(WorkflowNode):
    """N-way branch."""

    kind = "router"
    label = "Router"
    group = "flow"
    description = "Takes the branch of the first case whose rules hold, else 'default'."
    Config = RouterConfig
    branches = (DEFAULT_BRANCH,)
    dynamic_branches = True

    def branch_names(self) -> tuple[str, ...]:
        return (*(case.name for case in self.config.cases), DEFAULT_BRANCH)

    def rule_paths(self) -> list[str]:
        return [rule.path for case in self.config.cases for rule in case.rules]

    def validate_semantics(self, ctx) -> list[tuple[str, str]]:
        issues: list[tuple[str, str]] = []
        seen: set[str] = set()
        for index, case in enumerate(self.config.cases):
            if case.name == DEFAULT_BRANCH:
                issues.append((f"cases[{index}].name", "'default' is reserved for the fallback branch."))
            elif case.name in seen:
                issues.append((f"cases[{index}].name", f"Case name '{case.name}' is used twice."))
            seen.add(case.name)
        return issues

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        for case in ctx.config.cases:
            if evaluate_rules(case.rules, case.mode, ctx.scope):
                return NodeResult(output={"case": case.name}, branch=case.name)
        return NodeResult(output={"case": DEFAULT_BRANCH}, branch=DEFAULT_BRANCH)
