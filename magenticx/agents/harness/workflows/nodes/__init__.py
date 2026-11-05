"""The closed node catalogue: every kind a workflow may use, by ``kind``.

Adding a kind is a code change here — one module under ``nodes/`` with a
``WorkflowNode`` subclass, registered below. Nothing user-supplied ever becomes
a node class.
"""
from __future__ import annotations

from harness.workflows.nodes.approval import ApprovalNode
from harness.workflows.nodes.base import (
    NodeConfig,
    NodeContext,
    NodeResult,
    RunInfo,
    ValidationContext,
    WorkflowNode,
)
from harness.workflows.nodes.code_step import CodeNode
from harness.workflows.nodes.condition import ConditionNode
from harness.workflows.nodes.end import EndNode
from harness.workflows.nodes.fetch import FetchNode
from harness.workflows.nodes.llm import LlmNode
from harness.workflows.nodes.loop import LoopNode
from harness.workflows.nodes.router import RouterNode
from harness.workflows.nodes.set_state import SetNode
from harness.workflows.nodes.tool import ToolNode
from harness.workflows.nodes.trigger_manual import ManualTriggerNode
from harness.workflows.nodes.trigger_schedule import ScheduleTriggerNode
from harness.workflows.nodes.wait import WaitNode

#: kind -> class, in catalogue order (triggers, then work, then flow, then output).
NODE_KINDS: dict[str, type[WorkflowNode]] = {
    cls.kind: cls
    for cls in (
        ManualTriggerNode,
        ScheduleTriggerNode,
        LlmNode,
        ToolNode,
        CodeNode,
        FetchNode,
        SetNode,
        ConditionNode,
        RouterNode,
        LoopNode,
        WaitNode,
        ApprovalNode,
        EndNode,
    )
}


def node_class(kind: str) -> type[WorkflowNode] | None:
    """The class of a kind, or ``None`` for one not in the catalogue."""
    return NODE_KINDS.get(kind)


__all__ = [
    "NODE_KINDS",
    "NodeConfig",
    "NodeContext",
    "NodeResult",
    "RunInfo",
    "ValidationContext",
    "WorkflowNode",
    "node_class",
]
