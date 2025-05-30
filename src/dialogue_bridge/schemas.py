from pydantic import BaseModel
from typing import List, Optional, Dict



#-------------------------------------------
# CREATE USER USE CASE
#-------------------------------------------
class UserCreate(BaseModel):
    username: str
    password: str

class UserOut(BaseModel):
    user_id: str
    username: str



#-------------------------------------------
# AUTHENTICATE USER USE CASE
#-------------------------------------------
class AuthRequest(BaseModel):
    username: str
    password: str

class AuthResponse(BaseModel):
    authenticated: bool
    user_id: Optional[str] = None



#-------------------------------------------
# CONVERSATION USE CASES
#-------------------------------------------
class ConversationSummary(BaseModel):
    user_id: str
    conversation_id: str
    title: Optional[str] = None

    class Config:
        orm_mode = True
        extra = "ignore"

class Conversation(BaseModel):
    user_id: str
    conversation_id: str
    title: Optional[str] = None
    messages: List[Dict[str, str]]
    agents: List[str]

    class Config:
        orm_mode = True



#-------------------------------------------
# INFERENCE USE CASE
#-------------------------------------------







