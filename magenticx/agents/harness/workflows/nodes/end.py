"""``end`` — an optional terminal node that shapes the run's result.

``outputs`` maps result names to templates (``{"items": "{{state.results}}"}``);
the rendered map is the node's output and the run's ``RUN_FINISHED`` result.
With no ``outputs`` the result is the whole declared state.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import Field

from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode

MAX_OUTPUTS = 32


class EndConfig(NodeConfig):
    """Which values the run returns."""

    outputs: dict[str, Any] = Field(
        default_factory=dict,
        max_length=MAX_OUTPUTS,
        description="Result name -> value (templates allowed). Empty = the whole declared state.",
    )


class EndNode(WorkflowNode):
    """Terminal node; its outgoing edges are ignored by design (it has none)."""

    kind = "end"
    label = "End"
    group = "output"
    description = "Ends the run and picks what it returns."
    Config = EndConfig

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        if ctx.config.outputs:
            return NodeResult(output=dict(ctx.config.outputs))
        return NodeResult(output=dict(ctx.scope["state"]))
