"""Internal (service-to-service) memory endpoints.

These are **not** browser-facing: they are gated by `require_internal_caller`
(the shared internal proxy secret) AND blocked at the nginx edge
(`/api/v1/internal/`), so only the agents service — reaching the bridge directly
on the `backend` network — can call them. They back the agent's
`search_past_conversations` tool, which queries the bridge-owned `chat_db`
pgvector index on the user's behalf.
"""
from fastapi import APIRouter, Depends, status
from core.logging import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.security.internal_trust import require_internal_caller
from schema import MemoryMessageMatch, MemorySearchRequest
from utils.embeddings import search_user_messages

router = APIRouter()
logger = get_logger(__name__)


@router.post(
    "/memory/search",
    response_model=list[MemoryMessageMatch],
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
    summary="Internal: semantic search over a user's past messages (agent memory tool)",
)
async def searchUserMemory(
    body: MemorySearchRequest,
    db: AsyncSession = Depends(get_db),
):
    # user_id is trusted: only internal callers reach this (secret + nginx deny),
    # and the agents service only knows the user_id the bridge gave the run.
    set_context(user_id=body.user_id)
    results = await search_user_messages(
        db=db,
        user_id=body.user_id,
        query=body.query,
        limit=body.limit,
        exclude_conversation_id=body.exclude_conversation_id,
    )
    logger.info(
        "memory_search_completed",
        "Agent memory search completed",
        query_length=len(body.query.strip()),
        result_count=len(results),
    )
    return results
