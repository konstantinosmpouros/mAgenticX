"""Agent-memory DTOs: the Memory inspector's list rows and click-to-preview
detail, mirroring the ``entries/<name>.yml`` files the ``remember`` tool writes."""
from typing import Optional
from pydantic import BaseModel


class MemoryEntry(BaseModel):
    """One saved memory's metadata (no body) — a row in the Memory inspector list.

    Mirrors the `entries/<name>.yml` fields the `remember` tool writes, minus
    ``content``. ``source_conversation_id`` is the provenance pointer.
    """

    name: str
    summary: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    source_conversation_id: Optional[str] = None


class MemoryDetail(MemoryEntry):
    """A saved memory with its full ``content`` — the inspector's click-to-preview."""

    content: str = ""
