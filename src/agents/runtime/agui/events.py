from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel


# Custom event names/constants for AG-UI
HITL_INTERRUPT_EVENT_TYPE = "HITL_INTERRUPT"
PLAN_SNAPSHOT_EVENT_TYPE = "PLAN_SNAPSHOT"
TASK_SUBAGENT_EVENT_TYPE = "TASK_SUBAGENT"
SUBAGENT_EVENT_TYPE = "SUBAGENT_EVENT"
BEFORE_AGENT_EVENT_TYPE = "BEFORE_AGENT_EVENT"
TOKEN_USAGE_EVENT_TYPE = "TOKEN_USAGE"
CHECKPOINT_COMMITTED_EVENT_TYPE = "CHECKPOINT_COMMITTED"
PRESENT_ARTIFACT_EVENT_TYPE = "PRESENT_ARTIFACT"


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


# ------------------------------------------------------------------
# Token usage event
# ------------------------------------------------------------------
class TokenUsageEvent(BaseModel):
    """Per-AI-message token usage, pulled from ``AIMessage.usage_metadata``.

    Emitted once per settled AI message (main agent or sub-agent). The bridge
    sums these across the whole run — message_id lets it dedupe defensively.
    """
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    input_token_details: Optional[Dict[str, Any]] = None
    output_token_details: Optional[Dict[str, Any]] = None
    message_id: Optional[str] = None


# ------------------------------------------------------------------
# Checkpoint-committed event
# ------------------------------------------------------------------
class CheckpointCommittedEvent(BaseModel):
    """Terminal marker carrying the durable checkpoint head this run produced.

    Emitted once at the end of a /stream or /resume leg so the bridge can
    persist ``(thread_id, checkpoint_id)`` on the assistant message — the next
    turn resumes from this head and edit/retry fork from it. Rides the normal
    SSE pipe and lands in ``raw_events`` so it survives reconnection.
    """
    thread_id: str
    checkpoint_id: Optional[str] = None


# ------------------------------------------------------------------
# Present-artifact event
# ------------------------------------------------------------------
class PresentArtifactEvent(BaseModel):
    """A user-facing deliverable the agent has explicitly designated.

    Emitted when the orchestrator calls the ``present_artifact`` tool to hand a
    finished document to the user — the ONE intentional act that promotes a file
    out of the agent's scratch/helper docs into something the user sees. Carries
    display metadata only; the bytes stay on the agents-service volume until the
    bridge reads them back by ``path`` at run finalize and persists them as a
    generated attachment. Rides the normal SSE pipe and lands in ``raw_events``
    so the artifact card survives reconnection.
    """
    artifact_id: str
    path: str
    filename: str
    title: str
    summary: Optional[str] = None
    mime: Optional[str] = None
    status: Literal["ready"] = "ready"
