from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel


# Custom event names/constants for AG-UI
HITL_INTERRUPT_EVENT_TYPE = "HITL_INTERRUPT"
PLAN_SNAPSHOT_EVENT_TYPE = "PLAN_SNAPSHOT"
TASK_SUBAGENT_EVENT_TYPE = "TASK_SUBAGENT"
SUBAGENT_EVENT_TYPE = "SUBAGENT_EVENT"
BEFORE_AGENT_EVENT_TYPE = "BEFORE_AGENT_EVENT"


# ------------------------------------------------------------------
# HITL Interrupt Event
# ------------------------------------------------------------------
class HITLInterruptEvent(BaseModel):
    """Human-in-the-loop interrupt payload streamed to AG-UI."""
    thread_id: str
    interrupt: Any
    metadata: Optional[Dict[str, Any]] = None


# ------------------------------------------------------------------
# Planning Snapshot Event
# ------------------------------------------------------------------
class PlanItem(BaseModel):
    """Single planning step in a snapshot."""
    content: str
    status: Literal["pending", "in_progress", "completed"]
    metadata: Optional[Dict[str, Any]] = None

class PlanSnapshot(BaseModel):
    """Immutable snapshot of the current plan state."""
    items: List[PlanItem]
    updated_at: Optional[int] = None
    metadata: Optional[Dict[str, Any]] = None


# ------------------------------------------------------------------
# Task -> Sub-agent assignment Event
# ------------------------------------------------------------------
class TaskSubAgentEvent(BaseModel):
    """Describes a task delegated to a sub-agent."""
    task_id: str
    subagent_type: str
    description: str


# ------------------------------------------------------------------
# Sub-agent envelope Event
# ------------------------------------------------------------------
class SubAgentEvent(BaseModel):
    """
    Wraps any normalized AG-UI event emitted by a sub-agent namespace.
    """
    task_id: str
    namespace: List[str]
    event: Dict[str, Any]


# ------------------------------------------------------------------
# Before-agent event
# ------------------------------------------------------------------
class BeforeAgentEvent(BaseModel):
    """
    Captures the delegated instruction observed in
    PatchToolCallsMiddleware.before_agent.
    """
    message: str
    metadata: Optional[Dict[str, Any]] = None
