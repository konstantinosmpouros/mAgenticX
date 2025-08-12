from pydantic import BaseModel
from typing import List, Optional, Dict, Any



#-------------------------------------------
# CREATE USER SCHEMAS
#-------------------------------------------
class UserCreate(BaseModel):
    """Schema for creating a new user."""
    username: str
    password: str

class UserOut(BaseModel):
    """Schema for outputting user information."""
    user_id: str
    username: str



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
# CONVERSATION SCHEMAS
#-------------------------------------------
class ConversationSummary(BaseModel):
    """Schema for summarizing a conversation."""
    user_id: str
    conversation_id: str
    title: Optional[str] = None

    class Config:
        orm_mode = True
        extra = "ignore"

class Conversation(BaseModel):
    """Schema for a conversation, including messages and agents."""
    user_id: str
    conversation_id: str
    title: Optional[str] = None
    messages: List[Dict[str, Any]]
    agents: List[str]

    class Config:
        orm_mode = True



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



