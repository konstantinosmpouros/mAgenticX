from pydantic import BaseModel, Field, ConfigDict, model_validator
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

class AuthResponse(BaseModel):
    """Schema for user authentication response."""
    authenticated: bool = False
    user_id: str | None = None



#-------------------------------------------
# AGENTS DTO
#-------------------------------------------
class AgentFull(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    name: str
    description: str
    icon: str
    url: str
    is_active: bool
    created_at: datetime
    updated_at: datetime

class AgentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    name: str
    description: str
    icon: str



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
    agentId: str = Field(..., validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
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
    
    # Only for the raw base64 data (image)
    data: Optional[str] = None
    
    @model_validator(mode="after")
    def _inject_image_b64(self):
        if self.mime and self.mime.startswith("image/") and self.blob and self.blob.data:
            self.data = base64.b64encode(self.blob.data).decode("ascii")
        return self


class MessageOut(BaseModel):
    """Schema to expose all the info for a Message"""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    content: Optional[str] = None
    sender: Senders
    type: Types
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
    agentId: str = Field(..., validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
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
        if not self.content and not self.attachments:
            raise ValueError("Either 'content' or at least one attachment is required.")
        return self


class ConversationIn(BaseModel):
    """
    Create a conversation and persist the very first message.
    """
    agentId: str = Field(..., description="Target agent id")
    isPrivate: bool = Field(False, description="Optional privacy flag")
    title: Optional[str] = Field(None, description="Optional custom title")
    firstMessage: MessageIn





