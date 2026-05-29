from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from observability import get_logger, set_context
from schemas import SharedConversationDetail
from utils.shared_conv import load_active_share


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
    """Return a public share snapshot. This endpoint is intentionally unauthenticated."""
    set_context(session_id="shared-conversation")
    share = await load_active_share(token, db)
    snapshot = dict(share.snapshot_json or {})
    logger.info("shared_conversation_fetched", "Shared conversation fetched", share_id=share.id)
    return SharedConversationDetail(
        token=share.token,
        title=snapshot.get("title") or share.title,
        shareMode=snapshot.get("shareMode") or "branch",
        agent=snapshot.get("agent") or {},
        messages=snapshot.get("messages") or [],
        expiresAt=share.expires_at,
        createdAt=share.created_at,
    )
