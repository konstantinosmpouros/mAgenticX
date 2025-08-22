from pydantic import BaseModel, Field, ConfigDict, model_validator
import base64
from typing import List, Optional
from datetime import datetime


#-------------------------------------------
# AUTHENTICATE USER SCHEMAS
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
# AGENTS SCHEMAS
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
# CONVERSATION EXPORT SCHEMAS
#-------------------------------------------
class ConversationSummary(BaseModel):
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
    model_config = ConfigDict(from_attributes=True)
    data: bytes  # Pydantic v2 will base64 this if ever serialized, but we won't expose it directly.


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str = Field(..., validation_alias="file_name")
    mime: str = Field(..., validation_alias="mime_type")
    size: Optional[int] = Field(None, validation_alias="size_bytes")
    timestamp: datetime = Field(..., validation_alias="created_at")

    # keep ORM relation for computation but don't serialize it
    blob: Optional[BlobOut] = Field(None, validation_alias="blob", exclude=True)

    # what you asked for: only the raw base64 data if it's an image
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
    sender: str
    type: str
    created_at: datetime = Field(..., validation_alias="created_at")
    updated_at: datetime = Field(..., validation_alias="updated_at")
    attachments: List[AttachmentOut] = Field(default_factory=list)
    thinking: Optional[List[str]] = Field(None, validation_alias="reasoning_steps")
    thinkingTime: Optional[int] = Field(None, validation_alias="reasoning_time_seconds")
    error: Optional[bool] = Field(None, validation_alias="is_error")
    errorMessage: Optional[str] = Field(None, validation_alias="error_message")


class ConversationDetail(BaseModel):
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
# CONVERSATION CREATE SCHEMAS
#-------------------------------------------
class MessageCreate(BaseModel):
    """Schema to create a message with the least info available"""
    content: Optional[str] = None
    sender: str = "user"        # 'user' | 'agent' | 'ai' | 'assistant'
    type: str = "text"          # 'text' | 'file' | 'image' | 'audio' | 'tool'


class ConversationCreate(BaseModel):
    agentId: str = Field(..., validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(False, validation_alias="is_private")
    initialMessage: Optional[MessageCreate] = None

