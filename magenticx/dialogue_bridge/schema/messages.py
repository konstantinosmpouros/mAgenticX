"""Message DTOs: output shape, create input, streaming-placeholder update."""
from typing import List, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from core.settings import settings
from schema.attachments import AttachmentIn, AttachmentOut
from schema.base import Senders, UTCDateTime


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
    error: Optional[bool] = Field(None, validation_alias="is_error")
    errorMessage: Optional[str] = Field(None, validation_alias="error_message")
    # Final run lifecycle status of an assistant message (completed/cancelled/
    # failed) — the client's Done sentinel renders its flavor from this.
    streamingStatus: Optional[str] = Field(None, validation_alias="streaming_status")
    rawEvents: List[dict] = Field(default_factory=list, validation_alias="raw_events")

    @field_validator("rawEvents", mode="before")
    @classmethod
    def _coerce_raw_events(cls, v):
        return v if v is not None else []


class MessageIn(BaseModel):
    """
    Create a message (user/agent) with optional attachments.
    Either content or attachments must be provided.
    """
    parentMessageId: Optional[str] = None
    sender: Senders
    content: Optional[str] = None
    attachments: List[AttachmentIn] = Field(default_factory=list)

    # Optional metadata (your schema already supports on MessageTable)
    thinking: Optional[List[str]] = None
    thinkingTime: Optional[int] = None
    error: Optional[bool] = None
    errorMessage: Optional[str] = None
    rawEvents: List[dict] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_content_or_attachment(self):
        # Allow empty AI placeholders so the UI can allocate an id before streaming.
        if self.sender == "ai" and not self.content and not self.attachments:
            return self
        if not self.content and not self.attachments:
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
