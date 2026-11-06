"""``set`` — save values into the workflow's variables.

The only step that writes variables. ``values`` is ``{name: value}``; its
strings are templates rendered before the step runs, and each rendered value
overwrites that variable (``vars`` in the run state). Output: the rendered
values — so a ``set`` inside a loop keeps every pass in its ``outputs``.

Variables are not declared anywhere else: the keys of every ``set`` step's
``values`` are the workflow's variables (``WorkflowSpec.variables``), readable
as ``{{state.<name>}}`` from every step.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any

from pydantic import Field, StringConstraints

from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode
from harness.workflows.spec import NAME_PATTERN, SET_KIND

#: The most variables one ``set`` step writes.
MAX_VALUES = 32

VariableName = Annotated[str, StringConstraints(pattern=NAME_PATTERN)]


class SetConfig(NodeConfig):
    """The variable writes."""

    values: dict[VariableName, Any] = Field(
        min_length=1,
        max_length=MAX_VALUES,
        description="Variables to save: {name: value}. Values are templates. "
        "Every step can read a variable as {{state.<name>}}.",
        json_schema_extra={"x-widget": "assign"},
    )


class SetNode(WorkflowNode):
    """Overwrites the variables it names."""

    kind = SET_KIND
    label = "Set variables"
    group = "data"
    description = "Save values into variables; every step can read them."
    Config = SetConfig

    def writes(self) -> list[str]:
        """Its output plus every variable it sets."""
        return [*super().writes(), *(f"state.{name}" for name in self.config.values)]

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        cfg: SetConfig = ctx.config
        values = dict(cfg.values)
        return NodeResult(output=values, vars_update=dict(values))


__all__ = ["SetConfig", "SetNode"]
