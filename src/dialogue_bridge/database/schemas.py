from pydantic import BaseModel, Field, ConfigDict, model_validator, AliasChoices, field_validator
import base64
from typing import List, Optional, Literal
from datetime import datetime

Senders = Literal["user", "ai"]
Types = Literal["text", "file", "image", "audio", "tool"]


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
    vaultUserId: str = Field(..., validation_alias="vault_user_id")
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
    vaultUserId: Optional[str] = Field(None, validation_alias="vault_user_id")



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
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(..., validation_alias="is_private")
    lastMessage: Optional[str] = Field(None, validation_alias="last_message_preview")
    created_at: datetime = Field(..., validation_alias="created_at")
    updated_at: datetime = Field(..., validation_alias="updated_at")

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

class ConversationDetail(BaseModel):
    """
    Conversation DTO with all the info of a conversation.
    Used for export and presentation in the UI.
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    agent: AgentPublic = Field(..., validation_alias="agent")
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(..., validation_alias="is_private")
    created_at: datetime = Field(..., validation_alias="created_at")
    updated_at: datetime = Field(..., validation_alias="updated_at")
    messages: List[MessageOut] = Field(default_factory=list)



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

    @model_validator(mode="after")
    def _require_content_or_attachment(self):
        # Allow empty AI placeholders so the UI can allocate an id before streaming.
        if self.sender == "ai" and not self.content and not self.attachments:
            return self
        if not self.content and not self.attachments:
            raise ValueError("Either 'content' or at least one attachment is required.")
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

    @model_validator(mode="after")
    def _require_content(self):
        if self.content is None:
            raise ValueError("Message content is required to update the message.")
        return self

class ConversationIn(BaseModel):
    """Create a conversation and persist the very first message."""
    agentId: str = Field(..., description="Target agent id")
    isPrivate: bool = Field(False, description="Optional privacy flag")
    title: Optional[str] = Field(None, description="Optional custom title")
    firstMessage: MessageIn

class CreateConversationResponse(BaseModel):
    """Response when creating a conversation: summary + full detail."""
    detail: ConversationDetail
    summary: ConversationSummary

class InferenceStreamPayload(BaseModel):
    """Payload to map the messages branch from the UI and start an inference stream from the agent."""
    messagePath: list[str] | None = None
    enabledTools: list[ToolPreference] | None = Field(default=None, validation_alias="enabledTools")



#-------------------------------------------
# CONVERSATION UPDATE DTO
#-------------------------------------------
class UpdateConversationResponse(BaseModel):
    message: MessageOut
    summary: ConversationSummary



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
    title: str

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


