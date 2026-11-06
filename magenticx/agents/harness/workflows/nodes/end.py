"""``end`` — an optional terminal node that shapes the run's result and
decides what the next run starts with.

``outputs`` maps result names to templates (``{"items": "{{state.results}}"}``);
the rendered map is the node's output and the run's ``RUN_FINISHED`` result.
With no ``outputs`` the result is every variable (``{name: value}``).

``keep`` names variables to carry over: when the run completes, the current
value of each variable kept by an ``end`` step that ran is saved, and the next
run of the workflow starts with it (``runner.py``). Nothing else carries over.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any

from pydantic import Field, StringConstraints

from harness.workflows.nodes.base import (
    NodeConfig,
    NodeContext,
    NodeResult,
    ValidationContext,
    WorkflowNode,
)
from harness.workflows.spec import END_KIND, NAME_PATTERN

MAX_OUTPUTS = 32
MAX_KEEP = 32

VariableName = Annotated[str, StringConstraints(pattern=NAME_PATTERN)]


class EndConfig(NodeConfig):
    """Which values the run returns, and which variables the next run keeps."""

    outputs: dict[str, Any] = Field(
        default_factory=dict,
        max_length=MAX_OUTPUTS,
        description="Result name -> value (templates allowed). Empty = every variable.",
    )
    keep: list[VariableName] = Field(
        default_factory=list,
        max_length=MAX_KEEP,
        description="Variables whose value the next run starts with, when a run ends here.",
        json_schema_extra={"x-widget": "keep", "uniqueItems": True},
    )


class EndNode(WorkflowNode):
    """Terminal node; its outgoing edges are ignored by design (it has none)."""

    kind = END_KIND
    label = "End"
    group = "output"
    description = "Ends the run and picks what it returns."
    Config = EndConfig
    #: Variable names, not templates.
    literal_fields = frozenset({"keep"})

    def validate_semantics(self, ctx: ValidationContext) -> list[tuple[str, str]]:
        """``keep`` names each variable once, and only names some ``set`` step writes."""
        issues: list[tuple[str, str]] = []
        variables = set(self.spec.variables())
        seen: set[str] = set()
        for name in self.config.keep:
            if name in seen:
                issues.append(("keep", f"'{name}' is kept more than once."))
            elif name not in variables:
                issues.append(("keep", f"'{name}' is not a variable: no Set step writes it."))
            seen.add(name)
        return issues

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        if ctx.config.outputs:
            return NodeResult(output=dict(ctx.config.outputs))
        return NodeResult(output=dict(ctx.scope["state"]))


__all__ = ["EndConfig", "EndNode"]
