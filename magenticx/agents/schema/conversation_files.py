"""Bridge ↔ agents: a conversation's files (plan 43)."""
from pydantic import BaseModel, Field


class OutputFileOut(BaseModel):
    """One agent-generated deliverable read back from ``/conversation/output/``.

    Returned to the bridge (base64) so it can store the file as a generated
    attachment — a snapshot of the version presented. ``path`` is the virtual
    path the agent presented, echoed back so the bridge can rejoin it with the
    ``present_artifact`` event metadata."""
    path: str
    filename: str
    mime: str = "application/octet-stream"
    size: int = 0
    base64: str


class ReadOutputFilesResponse(BaseModel):
    """Bridge ← agents: the requested deliverables plus any paths that could not
    be returned (absent, oversized, or outside output/) so the caller skips them."""
    files: list[OutputFileOut]
    missing: list[str] = []


class ReapConversationRequest(BaseModel):
    """Bridge → agents: a deleted conversation's durable checkpoint threads.
    ``thread_ids`` are the distinct ``checkpoint_thread_id``s the bridge recorded
    for the conversation's runs (it owns that relational metadata); its files
    are found by the conversation id alone."""
    thread_ids: list[str] = []


class CopyConversationFilesRequest(BaseModel):
    """Bridge → agents: give a fork its source's files (paths only, no bytes)."""
    target_conversation_id: str = Field(min_length=1, max_length=128)


class CopyConversationFilesResponse(BaseModel):
    copied: int
