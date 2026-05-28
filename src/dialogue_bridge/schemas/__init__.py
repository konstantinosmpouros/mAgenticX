from pydantic import BaseModel, Field, ConfigDict, model_validator, AliasChoices, field_validator, computed_field
import base64
from typing import List, Optional, Literal
from datetime import datetime

Senders = Literal["user", "ai"]
Types = Literal["text", "file", "image", "audio", "tool"]

MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 10


#-------------------------------------------
# AUTHENTICATE USER DTO
#-------------------------------------------
class AuthRequest(BaseModel):
    """Schema for user authentication request."""
    username: str
    password: str

class UserProfile(BaseModel):
    """Public user profile returned to the client after authentication."""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    username: str
    email: Optional[str] = None
    displayName: Optional[str] = Field(None, validation_alias="display_name")
    fullName: Optional[str] = Field(None, validation_alias="full_name")
    avatarUrl: Optional[str] = Field(None, validation_alias="avatar_url")
    department: Optional[str] = None
    roleTitle: Optional[str] = Field(None, validation_alias="role_title")
    lastLoginAt: Optional[datetime] = Field(None, validation_alias="last_login_at")
    isActive: bool = Field(..., validation_alias="is_active")
    createdAt: datetime = Field(..., validation_alias="created_at")
    updatedAt: datetime = Field(..., validation_alias="updated_at")

class AuthResponse(BaseModel):
    """Schema for user authentication response."""
    authenticated: bool = False
    user_id: str | None = None
    user: UserProfile | None = None
    tokenTtl: Optional[int] = None



# -------------------------------------------
# DICTATION DTO
# -------------------------------------------
class DictationResponse(BaseModel):
    """Speech-to-text transcription payload returned to the UI."""
    text: str


#-------------------------------------------
# AGENTS DTO
#-------------------------------------------
class AgentFull(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    slug: str
    name: str
    description: str
    icon: str
    version: Optional[str] = None
    is_active: bool
    created_at: datetime
    updated_at: datetime

class AgentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str
    description: str
    icon: str
    version: Optional[str] = None
    isActive: bool = Field(..., validation_alias="is_active")


class WorkspaceSearchResult(BaseModel):
    """Flat search result consumed by the sidebar search panel."""
    kind: Literal["conversation", "message", "file", "agent"]
    id: str
    conversationId: Optional[str] = None
    agentId: Optional[str] = None
    title: str
    subtitle: Optional[str] = None
    snippet: Optional[str] = None
    updatedAt: Optional[datetime] = None



# -------------------------------------------
# MCP TOOLS DTO
# -------------------------------------------
class ToolManifest(BaseModel):
    server_id: str = Field("", validation_alias="server_id")
    tool_name: str = Field(..., validation_alias="tool_name")
    description: str = ""
    parameter_count: int = Field(0, ge=0, validation_alias="parameter_count")



# -------------------------------------------
# User preferences DTO
# -------------------------------------------
class ToolPreference(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    server_id: str = Field(
        "",
        validation_alias=AliasChoices("server_id", "serverId"),
        serialization_alias="serverId",
    )
    tool_name: str = Field(
        ...,
        validation_alias=AliasChoices("tool_name", "toolName"),
        serialization_alias="toolName",
    )

    @field_validator("server_id", "tool_name", mode="before")
    @classmethod
    def _coerce_and_strip(cls, v: str) -> str:
        if v is None:
            return ""
        if not isinstance(v, str):
            v = str(v)
        return v.strip()


class ToolsPreferences(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    disabled: list[ToolPreference] = Field(default_factory=list)

    @model_validator(mode="after")
    def _dedupe_disabled(self) -> "ToolsPreferences":
        """Normalize and deduplicate the disabled list by server/tool key."""
        cleaned: list[ToolPreference] = []
        seen: set[str] = set()

        for entry in self.disabled or []:
            tool_name = (entry.tool_name or "").strip()
            server_id = (entry.server_id or "").strip()
            if not tool_name:
                continue
            key = f"{server_id}::{tool_name}"
            if key in seen:
                continue
            seen.add(key)
            cleaned.append(
                ToolPreference(
                    server_id=server_id,
                    tool_name=tool_name,
                )
            )

        self.disabled = cleaned
        return self


class UserPreferences(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tools: ToolsPreferences = Field(default_factory=ToolsPreferences)
    prefersAgenticChat: bool = Field(
        default=False,
        validation_alias=AliasChoices("prefers_agentic_chat", "prefersAgenticChat"),
        serialization_alias="prefersAgenticChat",
    )
    suggestionsEnabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("suggestions_enabled", "suggestionsEnabled"),
        serialization_alias="suggestionsEnabled",
    )
    voiceModeVoice: str = Field(
        default="alloy",
        validation_alias=AliasChoices("voice_mode_voice", "voiceModeVoice"),
        serialization_alias="voiceModeVoice",
    )
    voiceModeLanguage: str = Field(
        default="english",
        validation_alias=AliasChoices("voice_mode_language", "voiceModeLanguage"),
        serialization_alias="voiceModeLanguage",
    )


class ReadAloudPreviewRequest(BaseModel):
    """Payload for previewing a read-aloud voice from profile settings."""
    voice: str = Field(default="alloy", min_length=1)
    text: str = Field(default="Hey! I am your AI speaker.", min_length=1, max_length=120)



#-------------------------------------------
# CONVERSATION EXPORT DTO
#-------------------------------------------
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
    archivedAt: Optional[datetime] = Field(None, validation_alias="archived_at")
    isReported: bool = Field(False, validation_alias="is_reported")
    reportedAt: Optional[datetime] = Field(None, validation_alias="reported_at")
    activeRunId: Optional[str] = Field(None, validation_alias="active_inference_run_id")
    lastMessage: Optional[str] = Field(None, validation_alias="last_message_preview")
    created_at: datetime = Field(..., validation_alias="created_at")
    updated_at: datetime = Field(..., validation_alias="updated_at")

    @computed_field
    @property
    def isStreaming(self) -> bool:
        return bool(self.activeRunId)

class BlobOut(BaseModel):
    """Schema to expose a Blob"""
    model_config = ConfigDict(from_attributes=True)
    data: bytes  # Pydantic v2 will base64 this if ever serialized, but we won't expose it directly.

class AttachmentOut(BaseModel):
    """Schema to expose all the info for an Attachment"""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str = Field(..., validation_alias="file_name")
    mime: str = Field(..., validation_alias="mime_type")
    size: Optional[int] = Field(None, validation_alias="size_bytes")
    timestamp: datetime = Field(..., validation_alias="created_at")

    # keep ORM relation for computation but don't serialize it
    blob: Optional[BlobOut] = Field(None, validation_alias="blob", exclude=True)
    blobId: Optional[str] = Field(None, validation_alias="blob_id")

    # Only for the raw base64 data (image)
    data: Optional[str] = None

    @model_validator(mode="after")
    def _inject_image_b64(self):
        if self.mime and self.mime.startswith("image/") and self.blob and self.blob.data:
            self.data = base64.b64encode(self.blob.data).decode("ascii")
            self.blob = None
        return self

class MessageOut(BaseModel):
    """Schema to expose all the info for a Message"""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    parentMessageId: Optional[str] = Field(None, validation_alias="parent_message_id")
    content: Optional[str] = None
    sender: Senders
    type: Types
    liked: Optional[bool] = Field(None, validation_alias="liked")
    created_at: datetime = Field(..., validation_alias="created_at")
    updated_at: datetime = Field(..., validation_alias="updated_at")
    attachments: List[AttachmentOut] = Field(default_factory=list)
    thinking: Optional[List[str]] = Field(None, validation_alias="reasoning_steps")
    thinkingTime: Optional[int] = Field(None, validation_alias="reasoning_time_seconds")
    error: Optional[bool] = Field(None, validation_alias="is_error")
    errorMessage: Optional[str] = Field(None, validation_alias="error_message")
    rawEvents: List[dict] = Field(default_factory=list, validation_alias="raw_events")

    @field_validator("rawEvents", mode="before")
    @classmethod
    def _coerce_raw_events(cls, v):
        return v if v is not None else []
    plan: Optional[dict] = Field(None, validation_alias="plan")
    subagents: Optional[dict] = Field(None, validation_alias="subagents")

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
    archivedAt: Optional[datetime] = Field(None, validation_alias="archived_at")
    isReported: bool = Field(False, validation_alias="is_reported")
    reportedAt: Optional[datetime] = Field(None, validation_alias="reported_at")
    activeRunId: Optional[str] = Field(None, validation_alias="active_inference_run_id")
    created_at: datetime = Field(..., validation_alias="created_at")
    updated_at: datetime = Field(..., validation_alias="updated_at")
    messages: List[MessageOut] = Field(default_factory=list)

    @computed_field
    @property
    def isStreaming(self) -> bool:
        return bool(self.activeRunId)



#-------------------------------------------
# CONVERSATION CREATE DTO
#-------------------------------------------
class AttachmentIn(BaseModel):
    """
    For uploads: we accept base64 payloads.
    Only images will ever be sent back base64-encoded by the API.
    """
    name: str
    mime: str
    dataB64: str
    size: Optional[int] = None  # if missing, will be computed from decoded bytes

    @field_validator("name", "mime", "dataB64", mode="before")
    @classmethod
    def _strip_attachment_fields(cls, value):
        if isinstance(value, str):
            return value.strip()
        return value

    @model_validator(mode="after")
    def _validate_attachment(self):
        # Basic presence checks
        if not self.name:
            raise ValueError("Attachment name is required.")
        if not self.mime:
            raise ValueError(f"Attachment '{self.name}' is missing a MIME type.")
        if not self.dataB64:
            raise ValueError(f"Attachment '{self.name}' is missing data.")

        # Validate base64 and decode to get raw bytes for size validation and potential re-encoding (for images).
        try:
            raw = base64.b64decode(self.dataB64, validate=True)
        except Exception as exc:
            raise ValueError(f"Attachment '{self.name}' is not valid base64.") from exc

        # Validate size constraints
        raw_size = len(raw)
        if raw_size <= 0:
            raise ValueError(f"Attachment '{self.name}' is empty.")
        if raw_size > MAX_ATTACHMENT_SIZE_BYTES:
            raise ValueError(f"Attachment '{self.name}' exceeds the {MAX_ATTACHMENT_SIZE_BYTES // (1024 * 1024)} MB limit.")
        if self.size is not None and self.size != raw_size:
            raise ValueError(f"Attachment '{self.name}' size metadata does not match payload size.")

        self.size = raw_size
        return self

class MessageIn(BaseModel):
    """
    Create a message (user/agent) with optional attachments.
    Either content or attachments must be provided.
    """
    parentMessageId: Optional[str] = None
    sender: Senders
    type: Types
    content: Optional[str] = None
    attachments: List[AttachmentIn] = Field(default_factory=list)

    # Optional metadata (your schema already supports on MessageTable)
    thinking: Optional[List[str]] = None
    thinkingTime: Optional[int] = None
    error: Optional[bool] = None
    errorMessage: Optional[str] = None
    rawEvents: List[dict] = Field(default_factory=list)
    plan: Optional[dict] = None
    subagents: Optional[dict] = None

    @model_validator(mode="after")
    def _require_content_or_attachment(self):
        # Allow empty AI placeholders so the UI can allocate an id before streaming.
        if self.sender == "ai" and not self.content and not self.attachments:
            return self
        if not self.content and not self.attachments:
            raise ValueError("Either 'content' or at least one attachment is required.")
        if len(self.attachments) > MAX_ATTACHMENTS_PER_MESSAGE:
            raise ValueError(f"No more than {MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed per message.")
        total_bytes = sum(item.size or 0 for item in self.attachments)
        if total_bytes > MAX_TOTAL_ATTACHMENT_BYTES:
            raise ValueError(
                f"Total attachment payload exceeds the {MAX_TOTAL_ATTACHMENT_BYTES // (1024 * 1024)} MB limit."
            )
        return self

class ConversationIn(BaseModel):
    """Create a conversation and persist the very first message."""
    agentId: str = Field(..., description="Target agent id")
    isPrivate: bool = Field(False, description="Optional privacy flag")
    title: Optional[str] = Field(None, description="Optional custom title")
    firstMessage: MessageIn

class ConversationForkIn(BaseModel):
    """Fork a conversation branch ending at a selected AI message."""
    messageId: str

class ConversationShareIn(BaseModel):
    """Create a read-only share snapshot ending at a selected AI message."""
    messageId: str
    mode: Literal["full", "branch", "message"] = "branch"
    branchPath: Optional[list[str]] = None
    expiresAt: Optional[datetime] = None

    @field_validator("branchPath", mode="before")
    @classmethod
    def _normalize_branch_path(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            return None
        normalized = [str(item).strip() for item in value if str(item).strip()]
        return normalized or None

    @model_validator(mode="after")
    def _validate_expiration(self):
        if self.expiresAt is None:
            return self
        expires_at = self.expiresAt.replace(tzinfo=None)
        if expires_at <= datetime.utcnow():
            raise ValueError("Share expiration must be in the future.")
        self.expiresAt = expires_at
        return self

class ConversationPdfExportIn(BaseModel):
    """Export a conversation scope as a transient PDF attachment."""
    messageId: str
    mode: Literal["full", "branch", "message"] = "full"
    branchPath: Optional[list[str]] = None

    @field_validator("branchPath", mode="before")
    @classmethod
    def _normalize_branch_path(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            return None
        normalized = [str(item).strip() for item in value if str(item).strip()]
        return normalized or None

class ContinueSharedConversationIn(BaseModel):
    """Create the caller's own conversation from a public share plus their first reply."""
    firstMessage: MessageIn

class ConversationShareResponse(BaseModel):
    """Owner response for a created share link."""
    id: str
    token: str
    shareUrl: str
    conversationId: str
    messageId: str
    shareMode: Literal["full", "branch", "message"] = "branch"
    title: Optional[str] = None
    isActive: bool = True
    revokedAt: Optional[datetime] = None
    expiresAt: Optional[datetime] = None
    createdAt: datetime

class ConversationShareListItem(BaseModel):
    """Owner-facing shared conversation link record."""
    id: str
    token: str
    shareUrl: str
    conversationId: str
    messageId: Optional[str] = None
    shareMode: Literal["full", "branch", "message"] = "branch"
    title: Optional[str] = None
    isActive: bool
    status: Literal["active", "expired", "revoked"]
    revokedAt: Optional[datetime] = None
    expiresAt: Optional[datetime] = None
    createdAt: datetime

class SharedConversationDetail(BaseModel):
    """Public read-only shared conversation snapshot."""
    token: str
    title: Optional[str] = None
    shareMode: Literal["full", "branch", "message"] = "branch"
    agent: AgentPublic
    messages: List[MessageOut] = Field(default_factory=list)
    expiresAt: Optional[datetime] = None
    createdAt: datetime

class CreateConversationResponse(BaseModel):
    """Response when creating a conversation: summary + full detail."""
    detail: ConversationDetail
    summary: ConversationSummary


class RealtimeVoiceSessionIn(BaseModel):
    """Browser SDP offer plus conversation context for a realtime voice session."""
    agentId: str
    conversationId: Optional[str] = None
    sdp: str = Field(..., min_length=1)
    voice: Optional[str] = None
    language: Optional[str] = None


class RealtimeVoiceSessionOut(BaseModel):
    """SDP answer and conversation context for a realtime voice session."""
    sdp: str
    model: str
    voice: str


class RealtimeVoiceConversationEventIn(BaseModel):
    """Persist a completed realtime voice transcript turn into the conversation."""
    conversationId: str
    role: Literal["user", "assistant"]
    transcript: str = Field(..., min_length=1)
    itemId: Optional[str] = None
    responseId: Optional[str] = None
    rawEvent: Optional[dict] = None


class RealtimeVoiceEndIn(BaseModel):
    conversationId: str


class RealtimeVoiceEndOut(BaseModel):
    summary: ConversationSummary



#-------------------------------------------
# INFERENCE RUN DTO
#-------------------------------------------
class InferenceRunStartPayload(BaseModel):
    """Payload to map the visible message branch and create a backend-owned inference run."""
    messagePath: list[str] | None = None
    enabledTools: list[ToolPreference] | None = Field(default=None, validation_alias="enabledTools")
    parentMessageId: str = Field(..., min_length=1)


class InferenceRunOut(BaseModel):
    """Backend-owned inference run visible to the frontend run manager."""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    userId: str = Field(..., validation_alias="user_id")
    conversationId: str = Field(..., validation_alias="conversation_id")
    assistantMessageId: str = Field(..., validation_alias="assistant_message_id")
    parentMessageId: Optional[str] = Field(None, validation_alias="parent_message_id")
    status: str
    messagePath: list[str] = Field(default_factory=list, validation_alias="message_path")
    enabledTools: list[dict] = Field(default_factory=list, validation_alias="enabled_tools")
    content: Optional[str] = None
    thinking: Optional[list[str]] = None
    rawEvents: list[dict] = Field(default_factory=list, validation_alias="raw_events")
    plan: Optional[dict] = None
    subagents: Optional[dict] = None
    errorMessage: Optional[str] = Field(None, validation_alias="error_message")
    startedAt: datetime = Field(..., validation_alias="started_at")
    completedAt: Optional[datetime] = Field(None, validation_alias="completed_at")
    cancelRequestedAt: Optional[datetime] = Field(None, validation_alias="cancel_requested_at")
    updatedAt: datetime = Field(..., validation_alias="updated_at")

    @field_validator("messagePath", "enabledTools", "rawEvents", mode="before")
    @classmethod
    def _coerce_json_lists(cls, value):
        return value if isinstance(value, list) else []


class InferenceRunStartResponse(BaseModel):
    run: InferenceRunOut
    message: MessageOut
    summary: ConversationSummary


class InferenceRunEvent(BaseModel):
    type: Literal["snapshot", "update", "terminal"]
    run: InferenceRunOut
    message: Optional[MessageOut] = None
    summary: Optional[ConversationSummary] = None



#-------------------------------------------
# CONVERSATION UPDATE DTO
#-------------------------------------------
class UpdateConversationResponse(BaseModel):
    message: MessageOut
    summary: ConversationSummary


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
    plan: Optional[dict] = None
    subagents: Optional[dict] = None

    @model_validator(mode="after")
    def _require_content(self):
        if self.content is None:
            raise ValueError("Message content is required to update the message.")
        return self



#-------------------------------------------
# DOCX PREVIEW TOKEN DTO
#-------------------------------------------
class DocxPreviewTokenOut(BaseModel):
    token: str
    expiresIn: int


#-------------------------------------------
# IMAGES RETRIEVAL DTO
#-------------------------------------------
class ImageOut(BaseModel):
    """Schema to expose all the info for an Image"""
    blobId: str = Field(..., validation_alias="blob_id")
    attachmentId: str = Field(..., validation_alias="attachment_id")
    fileName: str = Field(..., validation_alias="file_name")
    mime: str = Field(..., validation_alias="mime_type")
    createdAt: datetime = Field(..., validation_alias="created_at")
    dataB64: str



#-------------------------------------------
# TITLE DTO
#-------------------------------------------
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


__all__ = [
    "AuthRequest",
    "UserProfile",
    "AuthResponse",
    "DictationResponse",
    "AgentFull",
    "AgentPublic",
    "ToolManifest",
    "ToolPreference",
    "ToolsPreferences",
    "UserPreferences",
    "ConversationSummary",
    "BlobOut",
    "AttachmentOut",
    "MessageOut",
    "ConversationDetail",
    "AttachmentIn",
    "MessageIn",
    "ConversationIn",
    "ConversationForkIn",
    "ConversationShareIn",
    "ConversationPdfExportIn",
    "ContinueSharedConversationIn",
    "ConversationShareResponse",
    "ConversationShareListItem",
    "SharedConversationDetail",
    "CreateConversationResponse",
    "RealtimeVoiceSessionIn",
    "RealtimeVoiceSessionOut",
    "RealtimeVoiceConversationEventIn",
    "RealtimeVoiceEndIn",
    "RealtimeVoiceEndOut",
    "InferenceRunStartPayload",
    "InferenceRunOut",
    "InferenceRunStartResponse",
    "InferenceRunEvent",
    "UpdateConversationResponse",
    "MessageUpdate",
    "ImageOut",
    "TitleOut",
    "SuggestionsOut",
    "ConversationTitleUpdate",
    "ConversationReportIn",
]
