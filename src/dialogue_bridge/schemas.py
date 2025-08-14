from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Dict, Any
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
    authenticated: bool
    user_id: Optional[str] = None



#-------------------------------------------
# AGENTS SCHEMAS
#-------------------------------------------
class AgentFull(BaseModel):
    id: str
    name: str
    description: str
    icon: str           # lucide-react icon name
    url: str            # internal streaming URL

class AgentPublic(BaseModel):
    id: str
    name: str
    description: str
    icon: str



#-------------------------------------------
# CONVERSATION SCHEMAS
#-------------------------------------------
class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    name: str = Field(..., validation_alias="file_name")
    mime: str = Field(..., validation_alias="mime_type")
    size: Optional[int] = Field(None, validation_alias="size_bytes")
    path: str = Field(..., validation_alias="storage_path")
    timestamp: datetime = Field(..., validation_alias="created_at")


class MessageCreate(BaseModel):
    content: Optional[str] = None
    sender: str = "user"        # 'user' | 'agent' | 'ai' | 'assistant'
    type: str = "text"          # 'text' | 'file' | 'image' | 'audio' | 'tool'


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    content: Optional[str] = None
    sender: str
    type: str
    timestamp: datetime = Field(..., validation_alias="created_at")
    attachments: List[AttachmentOut] = []
    thinking: Optional[List[str]] = Field(None, validation_alias="reasoning_steps")
    thinkingTime: Optional[int] = Field(None, validation_alias="reasoning_time_seconds")
    error: Optional[bool] = Field(None, validation_alias="is_error")
    errorMessage: Optional[str] = Field(None, validation_alias="error_message")


class ConversationCreate(BaseModel):
    agentId: str = Field(..., validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(False, validation_alias="is_private")
    initialMessage: Optional[MessageCreate] = None


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


class ConversationDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    agentId: str = Field(..., validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
    title: Optional[str] = Field(None, validation_alias="title")
    isPrivate: bool = Field(..., validation_alias="is_private")
    created_at: datetime = Field(..., validation_alias="created_at")
    updated_at: datetime = Field(..., validation_alias="updated_at")
    messages: List[MessageOut]




