from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from observability import get_logger, logged_db_operation, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ConversationTable, get_db, UserTable
from schemas import (
    ConversationSummary,
    MessageIn,
    MessageOut,
    MessageUpdate,
    UpdateConversationResponse,
)
from core.auth_session import require_csrf_protection
from utils import (
    _preview,
    apply_ai_message_update,
    get_owned_message,
    init_message,
    toggle_message_reaction,
    validate_convId,
    validate_userId,
)


router = APIRouter()
logger = get_logger(__name__)


@router.post(
    "/{user_id}/{conversation_id}",
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

    async with logged_db_operation(
        logger=logger,
        db=db,
        success_event=None,
        failure_event="message_create_failed",
        success_message="Message added to conversation",
        failure_message="Message creation failed",
        parent_message_id=parent_message_id,
        sender=payload.sender,
        attachment_count=len(payload.attachments),
    ) as operation:
        # 1) Persist the new message and capture it
        msg = await init_message(db, current_conv, payload, parent_message_id=parent_message_id)

        # 2) Bump conversation metadata only when there is meaningful content/attachments
        preview = _preview(payload.content) or (payload.attachments[0].name if payload.attachments else None)
        if preview is not None:
            current_conv.last_message_preview = preview
            current_conv.last_message_at = datetime.now()

        await db.commit()
        operation.add(message_id=msg.id)

    # 3) Load only the inserted message with attachments (including blobs for images)
    msg_row = await get_owned_message(db, current_conv.id, msg.id)

    # Refresh conversation row so auto-updated columns (e.g., updated_at) are loaded
    message_out = MessageOut.model_validate(msg_row)
    await db.refresh(current_conv, attribute_names=["updated_at", "last_message_preview", "agent"])
    summary = ConversationSummary.model_validate(current_conv)
    logger.info("message_created", "Message added to conversation", **operation.snapshot())

    return UpdateConversationResponse(message=message_out, summary=summary)


@router.patch(
    "/{user_id}/{conversation_id}/{message_id}",
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
    Update an existing message (used to finalize AI placeholders after streaming).
    """
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=message_id)
    msg = await get_owned_message(db, conversation_id, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")
    if msg.sender != "ai":
        raise HTTPException(status_code=400, detail="Only AI messages can be updated.")

    async with logged_db_operation(
        logger=logger,
        db=db,
        success_event=None,
        failure_event="message_update_failed",
        success_message="AI message updated",
        failure_message="AI message update failed",
        message_id=message_id,
        raw_event_count=len(payload.rawEvents),
    ) as operation:
        apply_ai_message_update(msg, payload)

        preview = _preview(payload.content)
        if preview is not None:
            current_conv.last_message_preview = preview
        current_conv.last_message_at = datetime.now()

        operation.add(is_error=bool(msg.is_error))
        await db.commit()

    await db.refresh(msg)
    await db.refresh(current_conv, attribute_names=["updated_at", "last_message_preview", "agent"])
    summary = ConversationSummary.model_validate(current_conv)
    message_out = MessageOut.model_validate(msg)
    logger.info("message_updated", "AI message updated", **operation.snapshot())
    return UpdateConversationResponse(message=message_out, summary=summary)


@router.post(
    "/{user_id}/{conversation_id}/{message_id}/like",
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
    msg = await get_owned_message(db, conversation_id, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")

    toggle_message_reaction(msg, True)
    await db.commit()
    await db.refresh(msg)
    logger.info("message_like_toggled", "Message like toggled", liked=msg.liked)
    return MessageOut.model_validate(msg)


@router.post(
    "/{user_id}/{conversation_id}/{message_id}/dislike",
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
    msg = await get_owned_message(db, conversation_id, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")

    toggle_message_reaction(msg, False)
    await db.commit()
    await db.refresh(msg)
    logger.info("message_dislike_toggled", "Message dislike toggled", liked=msg.liked)
    return MessageOut.model_validate(msg)
