"""Inference-run DTOs: start payload/response, run view, HITL resume."""
from typing import Any, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator
from schema.base import UTCDateTime
from schema.conversations import ConversationDetail, ConversationSummary
from schema.messages import MessageIn, MessageOut


class InferenceStartPayload(BaseModel):
    """Backend-owned inference start request for new/send/edit/retry flows."""
    mode: Literal["new", "send", "edit", "retry", "shared_continue"]
    agentId: Optional[str] = None
    isPrivate: bool = False
    title: Optional[str] = None
    sharedConversationToken: Optional[str] = None
    conversationId: Optional[str] = None
    parentMessageId: Optional[str] = None
    targetMessageId: Optional[str] = None
    messagePath: list[str] | None = None
    message: Optional[MessageIn] = None


class InferenceRunOut(BaseModel):
    """Backend-owned inference run visible to the frontend run manager.

    After the inference_runs-table collapse this is built explicitly by
    :func:`utils.inference_runs.build_run_out_from_message` from a
    :class:`MessageTable` row — there is no longer a separate ORM model to
    validate from. ``id`` and ``assistantMessageId`` are both the message ID.
    """
    model_config = ConfigDict(populate_by_name=True)

    id: str
    userId: str
    conversationId: str
    assistantMessageId: str
    parentMessageId: Optional[str] = None
    status: str
    scheduledTaskId: Optional[str] = None
    messagePath: list[str] = Field(default_factory=list)
    content: Optional[str] = None
    thinking: Optional[list[str]] = None
    rawEvents: list[dict] = Field(default_factory=list)
    inputTokens: Optional[int] = None
    outputTokens: Optional[int] = None
    errorMessage: Optional[str] = None
    startedAt: UTCDateTime
    completedAt: Optional[UTCDateTime] = None
    cancelRequestedAt: Optional[UTCDateTime] = None
    updatedAt: UTCDateTime

    @field_validator("messagePath", "rawEvents", mode="before")
    @classmethod
    def _coerce_json_lists(cls, value):
        return value if isinstance(value, list) else []


class InferenceStartResponse(BaseModel):
    detail: ConversationDetail
    summary: ConversationSummary
    run: InferenceRunOut
    message: MessageOut


class ResumeActionDecisionIn(BaseModel):
    """One approve/reject decision for a single gated tool call in a batched
    HITL interrupt. Index-aligned to the interrupt's ``action_requests`` order;
    forwarded verbatim to the agents ``/resume`` endpoint."""
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None


class InferenceRunResumeIn(BaseModel):
    """Frontend → bridge payload for resuming a HITL-paused inference run.

    The bridge forwards this to the agents service's ``/resume`` endpoint
    which constructs a ``Command(resume=...)`` against the saved checkpoint.
    ``threadId`` is informational — the bridge always uses the conversation
    id as the LangGraph thread, so the field is accepted for symmetry with
    the agents-service shape but not relied upon.

    ``decisions`` is the per-action list for a *batched* interrupt (multiple
    gated tool calls in one turn): one entry per ``action_request`` in order,
    so the user can approve some and reject others. When omitted the single
    ``decision`` is replicated across all hanging tool calls (single-action /
    legacy path).

    ``interruptId`` is the LangGraph interrupt's unique id from the
    ``HITL_INTERRUPT`` event the user acted on; the agents service uses it
    to verify the request resolves the right pending interrupt when multiple
    HITLs fire in sequence on the same conversation.
    """
    model_config = ConfigDict(populate_by_name=True)

    interruptId: Optional[str] = None
    threadId: Optional[str] = None
    decision: Literal["approve", "reject"]
    reason: Optional[str] = None
    value: Optional[Any] = None
    decisions: Optional[List[ResumeActionDecisionIn]] = None
