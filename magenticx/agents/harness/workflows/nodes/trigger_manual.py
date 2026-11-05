"""``trigger.manual`` — the entry of a workflow started by hand ("Run now").

Its output is the run's validated inputs, so later nodes can read them either
as ``{{input.x}}`` or as ``{{nodes.<trigger>.output.x}}``.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from harness.workflows.nodes.base import NodeContext, NodeResult, WorkflowNode


class ManualTriggerNode(WorkflowNode):
    """Entry node; does no work of its own."""

    kind = "trigger.manual"
    label = "Manual trigger"
    group = "trigger"
    description = "Starts the workflow when it is run by hand. Output: the run's inputs."
    is_trigger = True

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        return NodeResult(output=dict(state.get("input") or {}))
