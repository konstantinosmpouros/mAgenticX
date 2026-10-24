"""Internal (agents → bridge) shapes for a conversation's uploads (plan 43)."""
from pydantic import BaseModel, Field


class InputFileOut(BaseModel):
    """One upload as the agent's ``/conversation/input/<name>``."""
    name: str
    attachment_id: str
    mime: str
    size: int
    sha256: str
    created_at: str | None = None


class InputFilesOut(BaseModel):
    files: list[InputFileOut]


class ExistingConversationsIn(BaseModel):
    """Which of these conversations does the user still have? Asked by the
    agents service's one-off move of its old volume trees (plan 43)."""
    user_id: str
    conversation_ids: list[str] = Field(default_factory=list, max_length=500)


class ExistingConversationsOut(BaseModel):
    conversation_ids: list[str]
