"""Internal (agents → bridge) shapes for a conversation's uploads (plan 43)."""
from pydantic import BaseModel


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
