"""Agent-memory inspector DTOs."""
from typing import Optional
from pydantic import BaseModel


class MemoryEntry(BaseModel):
    """One saved memory's metadata (no body) — a row in the Memory inspector.

    Mirrors :class:`agents.schemas.MemoryEntry`. ``source_conversation_id`` is
    the provenance pointer (the conversation the memory was saved from).
    """

    name: str
    summary: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    source_conversation_id: Optional[str] = None


class MemoryDetail(MemoryEntry):
    """A saved memory with its full ``content`` — the inspector's click-to-preview."""

    content: str = ""
