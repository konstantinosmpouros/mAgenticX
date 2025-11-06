from fastapi import APIRouter, Depends, HTTPException, status
from fastapi_pagination import Page
from fastapi_pagination.ext.sqlalchemy import paginate
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import ConversationTable, get_db, UserTable
from database.schemas import (
    ConversationDetail,
    ConversationIn,
    ConversationSummary,
    CreateConversationResponse,
)
from utils import (
    get_agent_by_id,
    init_conv,
    validate_convId,
    validate_convId_full,
    validate_userId,
)


router = APIRouter(prefix="/users/{user_id}", tags=["Conversations"])


@router.post(
    "/conversations",
    response_model=CreateConversationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new conversation for the user",
)
async def createConversation(
    user_id: str,
    payload: ConversationIn,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db)
) -> ConversationDetail:
    """
    Create a new conversation for the user and persist the very first message
    (with optional attachments). Returns the full conversation detail.
    """
    # Fetch agent metadata
    agent = await get_agent_by_id(payload.agentId)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown or inactive agent.")
    
    # Create conversation + first message atomically
    try:
        # Do all inserts/flushes
        conv = await init_conv(
            db=db,
            user=current_user,
            agent=agent,
            is_private=payload.isPrivate,
            title=payload.title,
            first_message=payload.firstMessage,
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    
    # Reload with nested attachments->blob so images get base64 injected by AttachmentOut
    conv_full = await validate_convId_full(user_id, conv.id, db)
    
    # Build both DTOs from the same ORM instance
    detail = ConversationDetail.model_validate(conv_full)
    summary = ConversationSummary.model_validate(conv_full)
    
    return CreateConversationResponse(detail=detail, summary=summary)


@router.get(
    "/conversations",
    response_model=Page[ConversationSummary],
    status_code=status.HTTP_200_OK,
    summary="Get paginated conversation summaries for the user",
)
async def getConvsSummary(
    user_id: str,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db)
):
    """
    Return a paginated conversation summary list for the user.
    Use query params: ?page=1&size=50
    """
    # fetch all full rows statement
    stmt = (
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
        .where(
            ConversationTable.user_id == user_id,
            ConversationTable.is_private == False,
        )
        .order_by(ConversationTable.updated_at.desc())
    )
    return await paginate(db, stmt)


@router.get(
    "/conversations/{conversation_id}",
    response_model=ConversationDetail,
    status_code=status.HTTP_200_OK,
    summary="Get one conversation (messages included) by user + conversation id",
)
async def getConvDetails(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
):
    """Fetch one conversation (messages included) by user + conversation id."""
    return ConversationDetail.model_validate(current_conv)


@router.delete(
    "/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a conversation by user + conversation id"
)
async def deleteConversation(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    db: AsyncSession = Depends(get_db),
):
    """Delete a conversation entirely (cascades to messages & attachments rows)."""
    await db.delete(current_conv)
    await db.commit()
    return
