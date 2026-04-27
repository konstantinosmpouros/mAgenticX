from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ConversationShareTable, get_db
from observability import get_logger, set_context
from schemas import SharedConversationDetail


router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/{token}",
    response_model=SharedConversationDetail,
    status_code=status.HTTP_200_OK,
    summary="Get a public read-only shared conversation snapshot",
)
async def getSharedConversation(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    """Return a public share snapshot. This endpoint is intentionally unauthenticated and read-only."""
    set_context(session_id="shared-conversation")
    result = await db.execute(
        select(ConversationShareTable).where(
            ConversationShareTable.token == token,
            ConversationShareTable.is_active == True,
            ConversationShareTable.revoked_at.is_(None),
        )
    )
    share = result.scalar_one_or_none()
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shared conversation not found.")

    snapshot = dict(share.snapshot_json or {})
    logger.info("shared_conversation_fetched", "Shared conversation fetched", share_id=share.id)
    return SharedConversationDetail(
        token=share.token,
        title=snapshot.get("title") or share.title,
        shareMode=snapshot.get("shareMode") or "branch",
        agent=snapshot.get("agent") or {},
        messages=snapshot.get("messages") or [],
        createdAt=share.created_at,
    )
