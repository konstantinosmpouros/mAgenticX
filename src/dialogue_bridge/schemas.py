from pydantic import BaseModel
from typing import List, Optional, Dict



#-------------------------------------------
# CREATE USER USE CASE
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
# AUTHENTICATE USER USE CASE
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
# CONVERSATION USE CASES
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
    messages: List[Dict[str, str]]
    agents: List[str]

    class Config:
        orm_mode = True





