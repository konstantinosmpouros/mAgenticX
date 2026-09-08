"""Memory-inspector endpoints — read + delete a (user, agent)'s saved memories.

The ``remember`` tool writes rows in ``agent_memories``; these internal endpoints
let the bridge (and ultimately the ProfilePanel Memory tab) list what is stored,
preview one entry, and delete one. There is no create/update endpoint — the agent
owns writes via the tool.

Reads go straight to the table rather than through the ``/memories/`` route. The
route exists to make the store look like a filesystem *to the model*; the
inspector wants the columns, including the provenance the yml deliberately omits.

All routes are internal-caller gated, mirroring the skills router. This service
is the only one that can serve them: ``agent_memories`` lives in
``agent_runtime``, which the bridge holds no connection to.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status

from core.security.internal_trust import require_internal_caller
from core.logging import get_logger
from harness.memory import AgentMemoryStore, get_memory_pool
from schema import MemoryDetail, MemoryEntry

logger = get_logger(__name__)

router = APIRouter()


def _iso(value: Any) -> Optional[str]:
    """Timestamps cross the wire as ISO strings — the DTO declares ``str``.

    The column is ``timestamptz``, so this conversion is the store↔schema seam.
    Returning a datetime here fails validation on the way out, which is exactly
    how the pool listing broke the Skills tab when that seam was missed there.
    """
    return value.isoformat() if hasattr(value, "isoformat") else value


def _entry(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": row["name"],
        "summary": row.get("summary") or "",
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
        "source_conversation_id": row.get("source_conversation_id"),
        "source_run_id": row.get("source_run_id"),
        "created_by": row.get("created_by") or "agent",
        "trust_level": row.get("trust_level") or "unknown",
    }


@router.get(
    "/agents/{agent_slug}/users/{user_id}/memories",
    response_model=List[MemoryEntry],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_agent_memories(agent_slug: str, user_id: str) -> List[MemoryEntry]:
    """Return this (user, agent)'s saved memories (metadata only), sorted by name."""
    store = AgentMemoryStore(get_memory_pool())
    rows = await store.list_pair(user_id, agent_slug)
    logger.info(
        "user_agent_memories_listed",
        "Served per-(user, agent) memory index",
        user_id=user_id,
        agent_slug=agent_slug,
        count=len(rows),
    )
    return [MemoryEntry(**_entry(row)) for row in rows]


@router.get(
    "/agents/{agent_slug}/users/{user_id}/memories/{name}",
    response_model=MemoryDetail,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_agent_memory_detail(agent_slug: str, user_id: str, name: str) -> MemoryDetail:
    """Return one saved memory with its full content (click-to-preview)."""
    store = AgentMemoryStore(get_memory_pool())
    row = await store.read_entry(user_id, agent_slug, name)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory not found.")
    return MemoryDetail(**_entry(row), content=row.get("content") or "")


@router.delete(
    "/agents/{agent_slug}/users/{user_id}/memories/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def delete_user_agent_memory(agent_slug: str, user_id: str, name: str) -> None:
    """Delete one memory. Idempotent — deleting one already gone is a no-op 204.

    One row, one delete. The ``AGENTS.md`` index the agent sees is derived from
    the remaining rows, so it cannot be left referencing a memory that is gone —
    which the previous two-file version had to keep in step by hand.
    """
    store = AgentMemoryStore(get_memory_pool())
    await store.delete_entry(user_id, agent_slug, name)
    logger.info(
        "user_agent_memory_deleted",
        "Deleted a per-(user, agent) memory",
        user_id=user_id,
        agent_slug=agent_slug,
        memory_name=name,
    )
