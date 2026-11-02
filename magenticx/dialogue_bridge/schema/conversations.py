"""Conversation lifecycle DTOs: create/fork/update, summaries + detail, titles, suggestions, reports."""
from typing import Any, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator
from schema.base import UTCDateTime
from schema.catalog import AgentPublic
from schema.messages import MessageIn, MessageOut


class _DraftAgentConversation:
    """A conversation read through, with a stand-in for the agent it has none of.

    Only a "Try it" trial of a never-created draft (plan 40) has no agent row.
    Its run frames and start response still carry a summary, so the agent is
    described from what the conversation recorded: the draft's name, under an
    empty id (there is no catalog entry to point at).
    """

    def __init__(self, conversation: Any) -> None:
        self._conversation = conversation

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conversation, name)

    @property
    def agent(self) -> AgentPublic:
        return AgentPublic(
            id="",
            name=getattr(self._conversation, "agent_name", None) or "Draft agent",
            description="",
            icon="",
            type="deep agent",
            isActive=True,
            kind="custom",
        )


def _with_draft_agent(data: Any) -> Any:
    """Validate an agentless conversation (ORM row) through the stand-in above."""
    if isinstance(data, dict) or getattr(data, "agent", True) is not None:
        return data
    return _DraftAgentConversation(data)


class ConversationSummary(BaseModel):
    """
    Conversation DTO with partial info of a conversation.
    Used for export and presentation in the UI sidebar (conversation history).
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    agent: AgentPublic = Field(..., validation_alias="agent")
    forkedParentId: Optional[str] = Field(None, validation_alias="forked_parent_id")
    forkedMessageId: Optional[str] = Field(None, validation_alias="forked_message_id")
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(..., validation_alias="is_private")
    isArchived: bool = Field(False, validation_alias="is_archived")
    archivedAt: Optional[UTCDateTime] = Field(None, validation_alias="archived_at")
    isPinned: bool = Field(False, validation_alias="is_pinned")
    pinnedAt: Optional[UTCDateTime] = Field(None, validation_alias="pinned_at")
    isReported: bool = Field(False, validation_alias="is_reported")
    reportedAt: Optional[UTCDateTime] = Field(None, validation_alias="reported_at")
    activeRunId: Optional[str] = Field(None, validation_alias="active_assistant_message_id")
    lastMessage: Optional[str] = Field(None, validation_alias="last_message_preview")
    created_at: UTCDateTime = Field(..., validation_alias="created_at")
    updated_at: UTCDateTime = Field(..., validation_alias="updated_at")

    @model_validator(mode="before")
    @classmethod
    def _agentless_trial(cls, data: Any) -> Any:
        return _with_draft_agent(data)

    @computed_field
    @property
    def isStreaming(self) -> bool:
        return bool(self.activeRunId)


class ConversationDetail(BaseModel):
    """
    Conversation DTO with all the info of a conversation.
    Used for export and presentation in the UI.
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    agent: AgentPublic = Field(..., validation_alias="agent")
    forkedParentId: Optional[str] = Field(None, validation_alias="forked_parent_id")
    forkedMessageId: Optional[str] = Field(None, validation_alias="forked_message_id")
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(..., validation_alias="is_private")
    isArchived: bool = Field(False, validation_alias="is_archived")
    archivedAt: Optional[UTCDateTime] = Field(None, validation_alias="archived_at")
    isPinned: bool = Field(False, validation_alias="is_pinned")
    pinnedAt: Optional[UTCDateTime] = Field(None, validation_alias="pinned_at")
    isReported: bool = Field(False, validation_alias="is_reported")
    reportedAt: Optional[UTCDateTime] = Field(None, validation_alias="reported_at")
    activeRunId: Optional[str] = Field(None, validation_alias="active_assistant_message_id")
    created_at: UTCDateTime = Field(..., validation_alias="created_at")
    updated_at: UTCDateTime = Field(..., validation_alias="updated_at")
    messages: List[MessageOut] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _agentless_trial(cls, data: Any) -> Any:
        return _with_draft_agent(data)

    @computed_field
    @property
    def isStreaming(self) -> bool:
        return bool(self.activeRunId)


class ConversationIn(BaseModel):
    """Create a conversation and persist the very first message."""
    agentId: str = Field(..., description="Target agent id")
    isPrivate: bool = Field(False, description="Optional privacy flag")
    title: Optional[str] = Field(None, description="Optional custom title")
    firstMessage: MessageIn


class ConversationForkIn(BaseModel):
    """Fork a conversation branch ending at a selected AI message."""
    messageId: str


class CreateConversationResponse(BaseModel):
    """Response when creating a conversation: summary + full detail."""
    detail: ConversationDetail
    summary: ConversationSummary


class UpdateConversationResponse(BaseModel):
    message: MessageOut
    summary: ConversationSummary


class TitleOut(BaseModel):
    titles: List[str]


class SuggestionsOut(BaseModel):
    suggestions: List[str]


class ConversationTitleUpdate(BaseModel):
    """Payload to update the title of an existing conversation."""
    title: str

    @model_validator(mode="after")
    def _normalize_and_validate(self):
        resolved = (self.title or "").strip()
        if not resolved:
            raise ValueError("Title cannot be empty.")
        # Keep titles reasonably short for sidebar rendering.
        if len(resolved) > 200:
            resolved = resolved[:200].rstrip()
        self.title = resolved
        return self


class ConversationVisibilityUpdate(BaseModel):
    """Save a private conversation as a normal one. One-way: a saved chat
    cannot be made private again, so the only accepted value is ``false``."""
    isPrivate: Literal[False]


class ConversationReportIn(BaseModel):
    """Payload to create a conversation report with an optional specific message target."""
    reason: str
    details: Optional[str] = None
    messageId: Optional[str] = Field(None, validation_alias="messageId")

    @model_validator(mode="after")
    def _normalize_and_validate(self):
        resolved_reason = (self.reason or "").strip()
        if not resolved_reason:
            raise ValueError("Reason is required.")
        if len(resolved_reason) > 120:
            resolved_reason = resolved_reason[:120].rstrip()

        resolved_details = (self.details or "").strip() or None
        if resolved_details and len(resolved_details) > 2000:
            resolved_details = resolved_details[:2000].rstrip()

        resolved_message_id = (self.messageId or "").strip() or None

        self.reason = resolved_reason
        self.details = resolved_details
        self.messageId = resolved_message_id
        return self
