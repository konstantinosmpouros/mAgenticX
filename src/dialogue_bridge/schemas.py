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
    name: str = Field(..., alias="file_name")
    mime: str = Field(..., alias="mime_type")
    size: Optional[int] = Field(None, alias="size_bytes")
    path: str = Field(..., alias="storage_path")
    timestamp: datetime = Field(..., alias="created_at")


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
    timestamp: datetime = Field(..., alias="created_at")
    attachments: List[AttachmentOut] = []
    thinking: Optional[List[str]] = Field(None, alias="reasoning_steps")
    thinkingTime: Optional[int] = Field(None, alias="reasoning_time_seconds")
    error: Optional[bool] = Field(None, alias="is_error")
    errorMessage: Optional[str] = Field(None, alias="error_message")


class ConversationCreate(BaseModel):
    agentId: str = Field(..., alias="agent_id")
    agentName: Optional[str] = Field(None, alias="agent_name")
    title: Optional[str] = None
    isPrivate: bool = Field(False, alias="is_private")
    initialMessage: Optional[MessageCreate] = None


class ConversationSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    agentId: str = Field(..., alias="agent_id")
    agentName: Optional[str] = Field(None, alias="agent_name")
    title: Optional[str] = None
    isPrivate: bool = Field(..., alias="is_private")
    lastMessage: Optional[str] = Field(None, alias="last_message_preview")
    created_at: datetime = Field(..., alias="created_at")
    updated_at: datetime = Field(..., alias="updated_at")


class ConversationDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    
    id: str
    agentId: str = Field(..., alias="agent_id")
    agentName: Optional[str] = Field(None, alias="agent_name")
    title: Optional[str] = None
    isPrivate: bool = Field(..., alias="is_private")
    created_at: datetime = Field(..., alias="created_at")
    updated_at: datetime = Field(..., alias="updated_at")
    messages: List[MessageOut]







#--------------------------
# TEMP SCHEMAS
#--------------------------
class UserCreate(BaseModel):
    username: str
    password: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None

class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    username: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime


