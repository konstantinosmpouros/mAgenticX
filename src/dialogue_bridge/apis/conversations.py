import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi_pagination import Page
from fastapi_pagination.ext.sqlalchemy import paginate
from observability import log_event, logged_db_operation, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import ConversationTable, get_db, UserTable
from schemas import (
    ConversationDetail,
    ConversationIn,
    ConversationSummary,
    CreateConversationResponse,
    ConversationTitleUpdate,
)
from vault_auth.session_auth import require_csrf_protection
from utils import (
    _preview,
    generate_conversation_title,
    get_agent_by_id,
    init_conv,
    validate_convId,
    validate_convId_full,
    validate_userId,
)


router = APIRouter(prefix="/users/{user_id}", tags=["Conversations"])
logger = logging.getLogger(__name__)


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
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db)
) -> ConversationDetail:
    """
    Create a new conversation for the user and persist the very first message
    (with optional attachments). Returns the full conversation detail.
    """
    set_context(user_id=user_id)
    # Fetch agent metadata
    agent = await get_agent_by_id(payload.agentId)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown or inactive agent.")

    resolved_title = (payload.title or "").strip() if payload.title else None
    
    # Auto-generate a title when none was provided
    if not resolved_title:
        generated = await generate_conversation_title(payload.firstMessage)
        if generated:
            resolved_title = generated
        else:
            preview_title = _preview(payload.firstMessage.content)
            fallback_source = "preview" if preview_title else ("agent_name" if agent.name else "default")
            resolved_title = preview_title or agent.name or "New conversation"
            log_event(
                logger,
                logging.INFO,
                "title_generation_fallback_used",
                "Conversation title fallback was used",
                agent_id=agent.id,
                fallback_source=fallback_source,
            )
    
    # Create conversation + first message atomically
    async with logged_db_operation(
        logger=logger,
        db=db,
        success_event=None,
        failure_event="conversation_create_failed",
        success_message="Conversation created",
        failure_message="Conversation creation failed",
        agent_id=payload.agentId,
        is_private=payload.isPrivate,
        attachment_count=len(payload.firstMessage.attachments),
        sender=payload.firstMessage.sender,
        message_type=payload.firstMessage.type,
    ) as operation:
        conv = await init_conv(
            db=db,
            user=current_user,
            agent=agent,
            is_private=payload.isPrivate,
            title=resolved_title,
            first_message=payload.firstMessage,
        )
        await db.commit()
        operation.add(conversation_id=conv.id)
    
    # Reload with nested attachments->blob so images get base64 injected by AttachmentOut
    conv_full = await validate_convId_full(user_id, conv.id, db)
    
    # Build both DTOs from the same ORM instance
    detail = ConversationDetail.model_validate(conv_full)
    summary = ConversationSummary.model_validate(conv_full)
    
    # Log conversation creation with relevant metadata and the first message details, for better observability of conversation creation and initial engagement
    log_event(logger, logging.INFO, "conversation_created", "Conversation created", **operation.snapshot())
    first_msg = conv_full.messages[0] if conv_full.messages else None
    log_event(
        logger,
        logging.INFO,
        "first_message_created",
        "First message persisted",
        message_id=first_msg.id if first_msg else None,
        sender=first_msg.sender if first_msg else None,
        attachment_count=len(first_msg.attachments) if first_msg else 0,
    )

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
    set_context(user_id=user_id)
    stmt = (
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
        .where(
            ConversationTable.user_id == user_id,
            ConversationTable.is_private == False,
        )
        .order_by(ConversationTable.updated_at.desc())
    )
    page = await paginate(db, stmt)
    log_event(
        logger,
        logging.INFO,
        "conversation_summary_list_fetched",
        "Conversation summary list fetched",
        total=page.total,
        page=page.page,
        size=page.size,
    )
    return page


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
    set_context(user_id=user_id, conversation_id=conversation_id)
    # Log a custom event with the conversation id and number of messages, for better observability of conversation engagement
    log_event(
        logger,
        logging.INFO,
        "conversation_details_fetched",
        "Conversation details fetched",
        conversation_id=conversation_id,
        message_count=len(current_conv.messages),
    )
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
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Delete a conversation entirely (cascades to messages & attachments rows)."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await db.delete(current_conv)
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "conversation_deleted",
        "Conversation deleted",
        conversation_id=conversation_id,
        agent_id=current_conv.agent_id
    )
    return


@router.patch(
    "/conversations/{conversation_id}/title",
    response_model=ConversationSummary,
    status_code=status.HTTP_200_OK,
    summary="Update a conversation title",
)
async def renameConversation(
    user_id: str,
    conversation_id: str,
    payload: ConversationTitleUpdate,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Rename an existing conversation and return the refreshed summary."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    current_conv.title = payload.title
    await db.commit()
    await db.refresh(current_conv, attribute_names=["title", "updated_at", "last_message_preview", "agent"])
    log_event(
        logger,
        logging.INFO,
        "conversation_renamed",
        "Conversation title updated",
        title_length=len(_preview(payload.title)),
        new_title=_preview(payload.title),
        conversation_id=conversation_id,
        agent_id=current_conv.agent_id
    )
    return ConversationSummary.model_validate(current_conv)
