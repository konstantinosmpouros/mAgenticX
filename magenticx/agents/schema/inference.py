"""Inference-run DTOs: the /stream and /resume payloads, manual compaction and
its undo. A conversation's files have their own: ``schema/conversation_files.py``."""
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class Request(BaseModel):
    """Pydantic model for incoming requests: a list of user input dictionaries."""
    messages: List[Dict[str, Any]]
    config: Dict[str, Any]


class ResumeActionDecision(BaseModel):
    """One approve/reject decision for a single gated tool call in a batched
    HITL interrupt. The list order is index-aligned to the interrupt's
    ``action_requests`` (LangChain maps ``decisions[i]`` to the i-th hanging
    tool call positionally)."""
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None


class ResumeItem(BaseModel):
    """One pending interrupt's decision inside a batched resume: the same
    fields as the single-decision shape, keyed by the interrupt it answers."""
    interrupt_id: str = Field(min_length=1, max_length=128)
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None
    value: Optional[Any] = None
    decisions: Optional[List[ResumeActionDecision]] = None


class AgentResumeRequest(BaseModel):
    """Resume payload for a LangGraph run paused on a HITL interrupt.

    The bridge forwards an approve/reject decision (plus an optional structured
    value or free-form reason) so the agents service can construct a
    ``Command(resume=...)`` against the saved checkpoint.

    ``decisions`` is the per-action list for a *batched* interrupt (the
    orchestrator gated multiple tool calls in one turn): one entry per
    ``action_request`` in order, enabling independent approve/reject. When
    omitted, the single ``decision`` is replicated across all hanging tool
    calls (legacy / single-action path).

    ``interrupt_id`` is the LangGraph interrupt's unique id from the
    ``HITL_INTERRUPT`` event the user acted on. When supplied the agents
    service verifies it is one of the checkpoint's pending interrupts — and
    resumes exactly that
    one — so a stale click can be 409'd instead of resolving the wrong one.

    ``resumes`` answers several pending interrupts in one go (parallel
    sub-agents each paused on an approval, answered together): one entry per
    interrupt, applied as ``Command(resume={interrupt_id: value, ...})``. When
    present it is the whole request and the top-level decision fields (the
    bridge mirrors its first entry there) are not read.
    """
    config: Dict[str, Any]
    thread_id: str
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None
    value: Optional[Any] = None
    interrupt_id: Optional[str] = None
    decisions: Optional[List[ResumeActionDecision]] = None
    resumes: Optional[List[ResumeItem]] = Field(default=None, min_length=1, max_length=64)


class CompactRequest(BaseModel):
    """Bridge → agents: compact this branch thread now (plan 34).

    ``config`` carries the same ``context`` block a run does (user,
    conversation, the agent's owner) so the agent is built for the right
    workspace. ``expected_checkpoint_id`` is the head the bridge recorded on the
    answer being compacted: a different head means the branch moved on and the
    request is refused rather than compacting someone else's state.
    """
    config: Dict[str, Any]
    thread_id: str = Field(min_length=1, max_length=128)
    expected_checkpoint_id: str = Field(min_length=1, max_length=128)


class CompactionUsageOut(BaseModel):
    """The summary call's spend — booked by the bridge like any model call."""
    calls: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    latency_ms: int = 0


class CompactResponse(BaseModel):
    """What a manual compaction did.

    ``status`` is ``compacted``, ``nothing_to_compact`` (everything fits in the
    part that is kept) or ``unsupported`` (this agent runs without a
    summarizer). Token figures are estimates except ``tokens_before``, which is
    the last reply's provider count when it has one.
    """
    status: Literal["compacted", "nothing_to_compact", "unsupported"]
    checkpoint_id: Optional[str] = None
    tokens_before: int = 0
    tokens_after: int = 0
    freed: int = 0
    window: Optional[int] = None
    summarized_messages: int = 0
    kept_messages: int = 0
    summary: str = ""
    model: Optional[str] = None
    usage: CompactionUsageOut = CompactionUsageOut()


class UndoCompactionRequest(BaseModel):
    """Bridge → agents: take back the compaction that is this branch's head."""
    config: Dict[str, Any]
    thread_id: str = Field(min_length=1, max_length=128)
    expected_checkpoint_id: str = Field(min_length=1, max_length=128)


class UndoCompactionResponse(BaseModel):
    """The new head, with the compaction state from before it restored."""
    checkpoint_id: str
