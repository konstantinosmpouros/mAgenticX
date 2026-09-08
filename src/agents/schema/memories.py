"""Agent-memory DTOs: the Memory inspector's list rows and click-to-preview detail.

Projected from ``agent_memories`` rows. The shape still mirrors the
``entries/<name>.yml`` the agent reads through the ``/memories/`` route, plus the
provenance columns that exist only in the table — deliberately not in the yml, so
the agent cannot rewrite its own audit trail through the filesystem tools."""
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
    # Provenance. A durable memory is future context, so an entry written by a
    # run that could reach external content has to stay identifiable — see the
    # `trust_level` column comment for how coarse that signal is.
    source_run_id: Optional[str] = None
    created_by: str = "agent"
    trust_level: str = "unknown"


class MemoryDetail(MemoryEntry):
    """A saved memory with its full ``content`` — the inspector's click-to-preview."""

    content: str = ""
