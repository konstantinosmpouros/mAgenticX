"""Message DTOs: output shape, create input, streaming-placeholder update."""
from typing import List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from core.settings import settings
from schema.attachments import AttachmentIn, AttachmentOut
from schema.base import Senders, UTCDateTime
from schema.commands import CommandInvocation


class MessageCompactionOut(BaseModel):
    """A manual compaction recorded on the answer it follows (plan 34).

    Read from the ``messages.compaction`` JSON, whose keys are snake_case. Only
    these fields leave the bridge: the stored record also keeps the compaction
    it replaced (for undo), which is internal, and never any checkpoint id.
    Token figures are estimates until the next model call reports the truth.
    """
    model_config = ConfigDict(populate_by_name=True)

    trigger: Literal["manual"] = "manual"
    tokensBefore: int = Field(0, validation_alias="tokens_before")
    tokensAfter: int = Field(0, validation_alias="tokens_after")
    freed: int = 0
    window: Optional[int] = None
    summarizedMessages: int = Field(0, validation_alias="summarized_messages")
    keptMessages: int = Field(0, validation_alias="kept_messages")
    summary: str = ""
    model: Optional[str] = None
    inputTokens: int = Field(0, validation_alias="input_tokens")
    cachedInputTokens: int = Field(0, validation_alias="cached_input_tokens")
    outputTokens: int = Field(0, validation_alias="output_tokens")
    latencyMs: int = Field(0, validation_alias="latency_ms")
    compactedAt: UTCDateTime = Field(..., validation_alias="compacted_at")
    undoneAt: Optional[UTCDateTime] = Field(None, validation_alias="undone_at")


class MessageOut(BaseModel):
    """Schema to expose all the info for a Message"""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    parentMessageId: Optional[str] = Field(None, validation_alias="parent_message_id")
    content: Optional[str] = None
    sender: Senders
    liked: Optional[bool] = Field(None, validation_alias="liked")
    agentId: Optional[str] = Field(None, validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
    created_at: UTCDateTime = Field(..., validation_alias="created_at")
    updated_at: UTCDateTime = Field(..., validation_alias="updated_at")
    attachments: List[AttachmentOut] = Field(default_factory=list)
    thinking: Optional[List[str]] = Field(None, validation_alias="reasoning_steps")
    thinkingTime: Optional[int] = Field(None, validation_alias="reasoning_time_seconds")
    inputTokens: Optional[int] = Field(None, validation_alias="input_tokens")
    outputTokens: Optional[int] = Field(None, validation_alias="output_tokens")
    cachedInputTokens: Optional[int] = Field(None, validation_alias="cached_input_tokens")
    reasoningTokens: Optional[int] = Field(None, validation_alias="reasoning_tokens")
    modelLatencyMs: Optional[int] = Field(None, validation_alias="model_latency_ms")
    contextTokens: Optional[int] = Field(None, validation_alias="context_tokens")
    contextWindow: Optional[int] = Field(None, validation_alias="context_window")
    compactionPercent: Optional[float] = Field(None, validation_alias="compaction_percent")
    modelName: Optional[str] = Field(None, validation_alias="model_name")
    error: Optional[bool] = Field(None, validation_alias="is_error")
    errorMessage: Optional[str] = Field(None, validation_alias="error_message")
    # Final run lifecycle status of an assistant message (completed/cancelled/
    # failed) — the client's Done sentinel renders its flavor from this.
    streamingStatus: Optional[str] = Field(None, validation_alias="streaming_status")
    rawEvents: List[dict] = Field(default_factory=list, validation_alias="raw_events")
    compaction: Optional[MessageCompactionOut] = None
    # The slash command this user message ran (plan 35), e.g. {"name": "explain"};
    # the bubble shows it as a chip in front of the content.
    command: Optional[CommandInvocation] = None

    @field_validator("rawEvents", mode="before")
    @classmethod
    def _coerce_raw_events(cls, v):
        return v if v is not None else []


class MessageIn(BaseModel):
    """
    Create a message (user/agent) with optional attachments.
    Either content or attachments must be provided — or a slash command, which
    may run with no text at all (``/summarize``).
    """
    parentMessageId: Optional[str] = None
    sender: Senders
    content: Optional[str] = None
    attachments: List[AttachmentIn] = Field(default_factory=list)
    # A slash command (plan 35): its argument is ``content``. User messages only.
    command: Optional[CommandInvocation] = None

    # Optional metadata (your schema already supports on MessageTable)
    thinking: Optional[List[str]] = None
    thinkingTime: Optional[int] = None
    error: Optional[bool] = None
    errorMessage: Optional[str] = None
    rawEvents: List[dict] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_content_or_attachment(self):
        # Allow empty AI placeholders so the UI can allocate an id before streaming.
        if self.command is not None and self.sender != "user":
            raise ValueError("Only a user message can run a command.")
        if self.sender == "ai" and not self.content and not self.attachments:
            return self
        if not self.content and not self.attachments and self.command is None:
            raise ValueError("Either 'content' or at least one attachment is required.")
        if len(self.attachments) > settings.attachments.max_per_message:
            raise ValueError(f"No more than {settings.attachments.max_per_message} attachments are allowed per message.")
        total_bytes = sum(item.size or 0 for item in self.attachments)
        if total_bytes > settings.attachments.max_total_bytes:
            raise ValueError(
                f"Total attachment payload exceeds the {settings.attachments.max_total_bytes // (1024 * 1024)} MB limit."
            )
        return self


class MessageUpdate(BaseModel):
    """
    Update an existing message (used for streaming AI placeholders).
    Content is required because this call finalises a previously empty message.
    """
    content: Optional[str] = None
    thinking: Optional[List[str]] = None
    thinkingTime: Optional[int] = None
    error: Optional[bool] = None
    errorMessage: Optional[str] = None
    rawEvents: List[dict] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_content(self):
        if self.content is None:
            raise ValueError("Message content is required to update the message.")
        return self
