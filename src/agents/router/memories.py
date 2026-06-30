"""Memory-inspector endpoints — read + delete a (user, agent)'s saved memories.

The `remember` tool writes the per-(user, agent) `/memories/` tree; these
internal endpoints let the bridge (and ultimately the ProfilePanel Memory tab)
list what's stored, preview one entry's full content, and delete one. A delete
removes both the `entries/<name>.yml` file and its `AGENTS.md` index row. There
is no create/update endpoint — the agent owns writes via the tool. All routes
are internal-caller gated, mirroring the skills router.
"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from core.proxy import require_internal_caller
from observability import get_logger
from runtime.filesystem import delete_memory, list_memories, read_memory
from schemas import MemoryDetail, MemoryEntry

logger = get_logger(__name__)

router = APIRouter()


@router.get(
    "/agents/{agent_slug}/users/{user_id}/memories",
    response_model=List[MemoryEntry],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_agent_memories(agent_slug: str, user_id: str) -> List[MemoryEntry]:
    """Return this (user, agent)'s saved memories (metadata only), sorted by name."""
    entries = list_memories(user_id, agent_slug)
    logger.info(
        "user_agent_memories_listed",
        "Served per-(user, agent) memory index",
        user_id=user_id,
        agent_slug=agent_slug,
        count=len(entries),
    )
    return [MemoryEntry(**entry) for entry in entries]


@router.get(
    "/agents/{agent_slug}/users/{user_id}/memories/{name}",
    response_model=MemoryDetail,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
)
async def get_user_agent_memory_detail(agent_slug: str, user_id: str, name: str) -> MemoryDetail:
    """Return one saved memory with its full content (click-to-preview)."""
    record = read_memory(user_id, agent_slug, name)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory not found.")
    return MemoryDetail(**record)


@router.delete(
    "/agents/{agent_slug}/users/{user_id}/memories/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_internal_caller)],
)
async def delete_user_agent_memory(agent_slug: str, user_id: str, name: str) -> None:
    """Delete one memory: removes its `entries/<name>.yml` and its AGENTS.md row.

    Idempotent — deleting a memory that's already gone is a no-op 204.
    """
    delete_memory(user_id, agent_slug, name)
    logger.info(
        "user_agent_memory_deleted",
        "Deleted a per-(user, agent) memory",
        user_id=user_id,
        agent_slug=agent_slug,
        memory_name=name,
    )
