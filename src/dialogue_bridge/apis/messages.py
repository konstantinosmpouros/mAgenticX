from datetime import datetime
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from observability import log_event, set_context
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import AttachmentTable, ConversationTable, MessageTable, get_db, UserTable
from database.schemas import (
    ConversationSummary,
    MessageIn,
    MessageOut,
    MessageUpdate,
    UpdateConversationResponse,
)
from vault_auth.session_auth import require_csrf_protection
from utils import (
    _preview,
    init_message,
    validate_convId,
    validate_userId,
)


router = APIRouter(prefix="/users/{user_id}", tags=["Messages"])
logger = logging.getLogger(__name__)


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
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> UpdateConversationResponse:
    """
    Append a new message (optionally with attachments) to an existing conversation.
    Returns only the appended message (with attachments) and the updated sidebar summary.
    """
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=None)
    parent_message_id = payload.parentMessageId
    
    try:
        # 1) Persist the new message and capture it
        msg = await init_message(db, current_conv, payload, parent_message_id=parent_message_id)
        
        # 2) Bump conversation metadata only when there is meaningful content/attachments
        preview = _preview(payload.content) or (payload.attachments[0].name if payload.attachments else None)
        if preview is not None:
            current_conv.last_message_preview = preview
            current_conv.last_message_at = datetime.now()
        
        await db.commit()
    except Exception as exc:
        log_event(
            logger,
            logging.ERROR,
            "message_create_failed",
            "Message creation failed",
            user_id=user_id,
            conversation_id=conversation_id,
            parent_message_id=parent_message_id,
            sender=payload.sender,
            message_type=payload.type,
            attachment_count=len(payload.attachments),
            error=str(exc),
        )
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
    log_event(
        logger,
        logging.INFO,
        "message_created",
        "Message added to conversation",
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=msg.id,
        sender=payload.sender,
        message_type=payload.type,
        attachment_count=len(payload.attachments),
        parent_message_id=parent_message_id,
    )
    
    return UpdateConversationResponse(message=message_out, summary=summary)


@router.patch(
    "/conversations/{conversation_id}/messages/{message_id}",
    response_model=UpdateConversationResponse,
    status_code=status.HTTP_200_OK,
    summary="Update an existing message within a conversation",
)
async def updateMessageInConversation(
    user_id: str,
    conversation_id: str,
    message_id: str,
    payload: MessageUpdate,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> UpdateConversationResponse:
    """
    Update an existing message (used to finalise AI placeholders after streaming).
    """
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=message_id)
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
    if msg.sender != "ai":
        raise HTTPException(status_code=400, detail="Only AI messages can be updated.")

    try:
        msg.content = payload.content
        msg.reasoning_steps = payload.thinking
        msg.reasoning_time_seconds = payload.thinkingTime
        if payload.error is not None:
            msg.is_error = bool(payload.error)
        msg.error_message = payload.errorMessage
        msg.raw_events = payload.rawEvents
        msg.plan = payload.plan
        msg.subagents = payload.subagents

        preview = _preview(payload.content)
        if preview is not None:
            current_conv.last_message_preview = preview
        current_conv.last_message_at = datetime.now()

        await db.commit()
    except Exception as exc:
        log_event(
            logger,
            logging.ERROR,
            "message_update_failed",
            "AI message update failed",
            user_id=user_id,
            conversation_id=conversation_id,
            message_id=message_id,
            raw_event_count=len(payload.rawEvents),
            error=str(exc),
        )
        await db.rollback()
        raise

    await db.refresh(msg)
    await db.refresh(current_conv, attribute_names=["updated_at", "last_message_preview", "agent"])
    summary = ConversationSummary.model_validate(current_conv)
    message_out = MessageOut.model_validate(msg)
    log_event(
        logger,
        logging.INFO,
        "message_updated",
        "AI message updated",
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        is_error=bool(msg.is_error),
    )
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
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    # Load message within the validated conversation, including attachments for UI consistency
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=message_id)
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
    log_event(
        logger,
        logging.INFO,
        "message_like_toggled",
        "Message like toggled",
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        liked=msg.liked,
    )
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
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=message_id)
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
    log_event(
        logger,
        logging.INFO,
        "message_dislike_toggled",
        "Message dislike toggled",
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        liked=msg.liked,
    )
    return MessageOut.model_validate(msg)


