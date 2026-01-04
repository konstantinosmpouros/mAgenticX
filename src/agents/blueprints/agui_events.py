from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel


# Custom event names/constants for AG-UI
HITL_INTERRUPT_EVENT_TYPE = "HITL_INTERRUPT"
PLAN_SNAPSHOT_EVENT_TYPE = "PLAN_SNAPSHOT"


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
