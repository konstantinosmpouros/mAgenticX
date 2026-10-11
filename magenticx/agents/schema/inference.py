"""Inference-run DTOs: the /stream and /resume payloads, manual compaction and
its undo, plus the per-conversation filesystem lifecycle calls the bridge makes
around a run (input seeding, output read-back, delete-time reap)."""
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
    service verifies it matches the checkpoint's currently-pending interrupt
    so a stale click (e.g. the user clicked the second card while the first
    was still in flight) can be 409'd instead of resolving the wrong one.
    """
    config: Dict[str, Any]
    thread_id: str
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None
    value: Optional[Any] = None
    interrupt_id: Optional[str] = None
    decisions: Optional[List[ResumeActionDecision]] = None


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


class InputFileIn(BaseModel):
    """One user-uploaded file to seed into a conversation's read-only input/."""
    filename: str
    mime: str = ""
    base64: str
    size: int = 0


class SeedInputFilesRequest(BaseModel):
    """Bridge → agents: persist these files into the conversation's input/ dir."""
    files: List[InputFileIn]


class SeedInputFilesResponse(BaseModel):
    """Virtual paths the agent can read (``/conversation/input/<name>``)."""
    written: List[str]


class OutputFileOut(BaseModel):
    """One agent-generated deliverable read back from ``/conversation/output/``.

    Returned to the bridge (base64) so it can persist the file as a generated
    attachment. ``path`` is the virtual path the agent presented, echoed back so
    the bridge can rejoin it with the ``present_artifact`` event metadata."""
    path: str
    filename: str
    mime: str = "application/octet-stream"
    size: int = 0
    base64: str


class OutputManifestEntry(BaseModel):
    """One file in the conversation's ``output/``, without its bytes."""
    path: str
    filename: str
    mime: str = "application/octet-stream"
    size: int = 0
    sha256: str


class OutputManifestResponse(BaseModel):
    """Bridge ← agents: every file in ``output/``, so the bridge can store the
    new or changed ones at run end (presented or not)."""
    files: List[OutputManifestEntry]


class ReadOutputFilesResponse(BaseModel):
    """Bridge ← agents: the requested deliverables plus any paths that could not
    be returned (absent, oversized, or off-mount) so the caller skips them."""
    files: List[OutputFileOut]
    missing: List[str] = []


class ReapConversationRequest(BaseModel):
    """Bridge → agents: reap a conversation's durable checkpoint threads and its
    per-(user, agent) filesystem dir on conversation delete. ``thread_ids`` are
    the distinct ``checkpoint_thread_id``s the bridge recorded for the
    conversation's runs (it owns that relational metadata)."""
    thread_ids: List[str] = []
