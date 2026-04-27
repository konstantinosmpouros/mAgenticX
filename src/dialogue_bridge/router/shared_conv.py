from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth_session import require_current_user, require_csrf_protection
from core.database import UserTable, get_db
from observability import get_logger, set_context
from schemas import ContinueSharedConversationIn, CreateConversationResponse, SharedConversationDetail
from utils.shared_conv import create_conversation_from_share, load_active_share


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


@router.post(
    "/{token}/continue",
    response_model=CreateConversationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a private conversation from a public share and first reply",
)
async def continueSharedConversation(
    token: str,
    payload: ContinueSharedConversationIn,
    current_user: UserTable = Depends(require_current_user),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Import a full shared snapshot into the authenticated user's workspace and append their first reply."""
    set_context(user_id=current_user.id, session_id="shared-conversation-continue")
    share = await load_active_share(token, db)
    snapshot = dict(share.snapshot_json or {})
    if snapshot.get("shareMode") != "full":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only full-conversation shares can be continued.",
        )

    response = await create_conversation_from_share(
        db=db,
        share=share,
        current_user=current_user,
        payload=payload,
    )
    logger.info(
        "shared_conversation_continued",
        "Shared conversation imported and continued",
        share_id=share.id,
        conversation_id=response.detail.id,
    )
    return response
