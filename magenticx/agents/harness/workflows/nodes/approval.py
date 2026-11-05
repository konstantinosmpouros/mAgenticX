"""``approval`` — pause the run until a person approves or rejects.

Calls LangGraph ``interrupt`` with a ``workflow.approval`` value; the node
wrapper streams it as the same ``HITL_INTERRUPT`` custom event agent runs use
(``metadata.source = "workflow.approval"``). The run's checkpoint holds the
pause, so the resume — ``{decision: approve|reject, comment?}`` on the same
thread — can come much later and from another process. An approval node always
pauses: it is the explicit "ask me first" of a workflow.

Branches ``approved`` / ``rejected``. Output: ``{"decision", "comment"}``.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from langgraph.types import interrupt
from pydantic import Field

from harness.workflows.errors import NodeExecutionError
from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode

#: ``value.type`` of the interrupt, so a resume can check what it answers.
APPROVAL_INTERRUPT_TYPE = "workflow.approval"
DECISIONS = ("approve", "reject")
MAX_COMMENT_CHARS = 2000


class ApprovalConfig(NodeConfig):
    """What the person is asked, and what they see alongside it."""

    message: str = Field(min_length=1, max_length=2000, description="The question shown to the approver")
    payload: Any = Field(default=None, description="Data shown with the question (templates allowed)")


class ApprovalNode(WorkflowNode):
    """Human-in-the-loop gate."""

    kind = "approval"
    label = "Approval"
    group = "flow"
    description = "Pauses until someone approves or rejects; branches 'approved' / 'rejected'."
    Config = ApprovalConfig
    branches = ("approved", "rejected")

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        answer = interrupt(
            {
                "type": APPROVAL_INTERRUPT_TYPE,
                "nodeId": self.id,
                "executionId": ctx.execution_id,
                "message": ctx.config.message,
                "payload": ctx.config.payload,
                "allowedDecisions": list(DECISIONS),
            }
        )
        decision = answer.get("decision") if isinstance(answer, dict) else None
        if decision not in DECISIONS:
            raise NodeExecutionError("The approval was answered without a valid decision.", code="approval")
        comment = answer.get("comment")
        comment = str(comment)[:MAX_COMMENT_CHARS] if comment else None
        return NodeResult(
            output={"decision": decision, "comment": comment},
            branch="approved" if decision == "approve" else "rejected",
        )
