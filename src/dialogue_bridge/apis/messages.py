from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import AttachmentTable, ConversationTable, MessageTable, get_db, UserTable
from database.schemas import (
    ConversationSummary,
    MessageIn,
    MessageOut,
    UpdateConversationResponse,
)
from utils import (
    _preview,
    init_message,
    validate_convId,
    validate_userId,
)


router = APIRouter(prefix="/users/{user_id}", tags=["Messages"])


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=UpdateConversationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a new message to an existing conversation",
)
async def addMessageToConversation(
    user_id: str,
    conversation_id: str,
    payload: MessageIn,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    db: AsyncSession = Depends(get_db),
) -> UpdateConversationResponse:
    """
    Append a new message (optionally with attachments) to an existing conversation.
    Returns only the appended message (with attachments) and the updated sidebar summary.
    """
    parent_message_id = payload.parentMessageId
    
    try:
        # 1) Persist the new message and capture it
        msg = await init_message(db, current_conv, payload, parent_message_id=parent_message_id)
        
        # 2) Bump conversation metadata
        current_conv.last_message_preview = (
            _preview(payload.content) or
            (payload.attachments[0].name if payload.attachments else None)
        )
        current_conv.last_message_at = datetime.now()
        
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    
    # 3) Load only the inserted message with attachments (including blobs for images)
    stmt = (
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(MessageTable.id == msg.id)
    )
    result = await db.execute(stmt)
    msg_row = result.scalar_one_or_none()
    
    # Refresh conversation row so auto-updated columns (e.g., updated_at) are loaded
    message_out = MessageOut.model_validate(msg_row)
    await db.refresh(current_conv, attribute_names=["updated_at", "last_message_preview", "agent"])
    summary = ConversationSummary.model_validate(current_conv)
    
    return UpdateConversationResponse(message=message_out, summary=summary)


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/like",
    response_model=MessageOut,
    status_code=status.HTTP_200_OK,
    summary="Like a message in a conversation",
)
async def likeMessage(
    user_id: str,
    conversation_id: str,
    message_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    db: AsyncSession = Depends(get_db),
):
    # Load message within the validated conversation, including attachments for UI consistency
    stmt = (
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(
            MessageTable.id == message_id,
            MessageTable.conversation_id == conversation_id,
        )
    )
    res = await db.execute(stmt)
    msg = res.scalar_one_or_none()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")
    
    # Toggle semantics: clicking like again clears the reaction
    msg.liked = None if msg.liked is True else True
    await db.commit()
    await db.refresh(msg)
    return MessageOut.model_validate(msg)


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/dislike",
    response_model=MessageOut,
    status_code=status.HTTP_200_OK,
    summary="Dislike a message in a conversation",
)
async def dislikeMessage(
    user_id: str,
    conversation_id: str,
    message_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(
            MessageTable.id == message_id,
            MessageTable.conversation_id == conversation_id,
        )
    )
    res = await db.execute(stmt)
    msg = res.scalar_one_or_none()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")
    
    # Toggle semantics: clicking dislike again clears the reaction
    msg.liked = None if msg.liked is False else False
    await db.commit()
    await db.refresh(msg)
    return MessageOut.model_validate(msg)







