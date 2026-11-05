"""``set`` — write values into the workflow's declared state.

The same thing ``assign`` does on any node, as a step of its own: ``values`` is
``{state field: value}``, its strings are templates rendered before the step
runs, and the rendered values are written through the fields' declared
reducers and type checks — exactly the path an ``assign`` write takes (the base
class's ``_state_writes``). Output: the rendered values.

Every key must be a declared state field; the validator says which one is not.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import Field

from harness.workflows.nodes.base import (
    MAX_ASSIGNMENTS,
    NodeConfig,
    NodeContext,
    NodeResult,
    ValidationContext,
    WorkflowNode,
)


class SetConfig(NodeConfig):
    """The state writes."""

    values: dict[str, Any] = Field(
        min_length=1,
        max_length=MAX_ASSIGNMENTS,
        description="State fields to write: {field: value}. Values are templates.",
        json_schema_extra={"x-widget": "assign"},
    )


class SetNode(WorkflowNode):
    """Writes declared state fields."""

    kind = "set"
    label = "Set state"
    group = "data"
    description = "Write values into the workflow's state."
    Config = SetConfig

    def writes(self) -> list[str]:
        """Its output plus every field it sets (and any ``assign`` on top)."""
        writes = super().writes()
        return [*writes, *(f"state.{name}" for name in self.config.values if f"state.{name}" not in writes)]

    def validate_semantics(self, ctx: ValidationContext) -> list[tuple[str, str]]:
        return [
            ("values", f"'{name}' is not a declared state field.")
            for name in self.config.values
            if name not in self.fields
        ]

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        cfg: SetConfig = ctx.config
        values = dict(cfg.values)
        return NodeResult(output=values, state_update=dict(values))


__all__ = ["SetConfig", "SetNode"]
