"""Memories router — inspect + delete a (user, agent)'s saved long-term memories.

The agent writes memories via its `remember` tool; this router is the *user*'s
read + correct surface (the ProfilePanel Memories tab):

- ``GET /v1/memories/users/{user_id}/agents/{agent_id}`` — list saved memories
  (metadata only), sorted by name.
- ``GET /v1/memories/users/{user_id}/agents/{agent_id}/{name}`` — one memory's
  full content (click-to-preview).
- ``DELETE /v1/memories/users/{user_id}/agents/{agent_id}/{name}`` — delete a
  memory (drops its yml + AGENTS.md row upstream). CSRF-protected.

There is no create/update — the agent owns writes. The bridge proxies to the
agents service (which owns the filesystem volume); the on-disk per-(user, agent)
``/memories/`` tree is the source of truth, not Postgres.
"""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, status
from observability import get_logger, set_context

from core.auth.session import AuthUser, require_csrf_protection
from schemas import MemoryDetail, MemoryEntry
from utils import validate_userId
from utils.memories import (
    delete_agent_memory,
    get_agent_memory_detail,
    list_agent_memories,
)

router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/users/{user_id}/agents/{agent_id}",
    response_model=List[MemoryEntry],
    status_code=status.HTTP_200_OK,
)
async def get_user_agent_memories(
    user_id: str,
    agent_id: str,
    _: AuthUser = Depends(validate_userId),
) -> List[MemoryEntry]:
    """Return the memories this agent has saved about the user, sorted by name."""
    set_context(user_id=user_id, agent_id=agent_id)
    memories = await list_agent_memories(user_id=user_id, agent_id=agent_id)
    logger.info(
        "user_agent_memories_served",
        "Served per-(user, agent) memory index",
        count=len(memories),
    )
    return [MemoryEntry.model_validate(entry) for entry in memories]


@router.get(
    "/users/{user_id}/agents/{agent_id}/{name}",
    response_model=MemoryDetail,
    status_code=status.HTTP_200_OK,
)
async def get_user_agent_memory_detail(
    user_id: str,
    agent_id: str,
    name: str,
    _: AuthUser = Depends(validate_userId),
) -> MemoryDetail:
    """Return one saved memory with its full content."""
    set_context(user_id=user_id, agent_id=agent_id)
    detail = await get_agent_memory_detail(user_id=user_id, agent_id=agent_id, name=name)
    return MemoryDetail.model_validate(detail)


@router.delete(
    "/users/{user_id}/agents/{agent_id}/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_user_agent_memory(
    user_id: str,
    agent_id: str,
    name: str,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
) -> None:
    """Delete one of the agent's saved memories. Idempotent."""
    set_context(user_id=user_id, agent_id=agent_id)
    await delete_agent_memory(user_id=user_id, agent_id=agent_id, name=name)
