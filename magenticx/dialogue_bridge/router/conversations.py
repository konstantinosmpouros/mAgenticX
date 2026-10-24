from secrets import token_urlsafe

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi_pagination import Page
from fastapi_pagination.ext.sqlalchemy import apaginate
from core.logging import get_logger, logged_db_operation, set_context
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone

from core.database import ConversationReportTable, ConversationShareTable, ConversationTable, get_db
from schema import (
    CompactConversationIn,
    CompactConversationOut,
    ConversationDetail,
    ConversationForkIn,
    ConversationIn,
    ConversationPdfExportIn,
    ConversationReportIn,
    ConversationShareIn,
    ConversationShareListItem,
    ConversationShareResponse,
    ConversationSummary,
    CreateConversationResponse,
    ConversationTitleUpdate,
    ConversationVisibilityUpdate,
    MessageOut,
)
from core.auth.session import AuthUser, require_csrf_protection
from core.security.rate_limit import compaction_rate_limit, export_pdf_rate_limit, share_create_rate_limit
from utils.agents import copy_conversation_files
from utils.attachments import encode_disposition
from utils.share_export import conversation_pdf_filename, render_conversation_pdf, select_scoped_messages
from utils import (
    _preview,
    build_message_lineage,
    build_share_snapshot,
    clone_branch_to_conversation,
    conversation_summaries_query,
    get_agent_by_id,
    get_conversation_with_agent,
    get_owned_message,
    get_share_for_owner,
    init_conv,
    list_owned_shares,
    resolve_conversation_title,
    save_private_conversation,
    set_conversation_archive_state,
    set_conversation_pin_state,
    validate_convId,
    validate_convId_full,
    validate_userId,
)
from utils.compaction import compact_conversation, undo_conversation_compaction
from utils.runtime_reaps import drain_runtime_reaps, enqueue_runtime_reap
from utils.shared_conv import build_share_list_item, resolve_share_expires_at


router = APIRouter()
logger = get_logger(__name__)


@router.post(
    "/{user_id}",
    response_model=CreateConversationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new conversation for the user",
)
async def createConversation(
    user_id: str,
    payload: ConversationIn,
    current_user: AuthUser = Depends(validate_userId),
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

    resolved_title = await resolve_conversation_title(
        first_message=payload.firstMessage,
        explicit_title=payload.title,
        agent_name=agent.name,
        agent_id=agent.id,
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
    logger.info("conversation_created", "Conversation created", **operation.snapshot())
    first_msg = conv_full.messages[0] if conv_full.messages else None
    logger.info("first_message_created", "First message persisted", message_id=first_msg.id if first_msg else None, sender=first_msg.sender if first_msg else None, attachment_count=len(first_msg.attachments) if first_msg else 0)

    return CreateConversationResponse(detail=detail, summary=summary)


@router.post(
    "/{user_id}/{conversation_id}/fork",
    response_model=ConversationSummary,
    status_code=status.HTTP_201_CREATED,
    summary="Fork a conversation branch into a new conversation",
)
async def forkConversation(
    user_id: str,
    conversation_id: str,
    payload: ConversationForkIn,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Clone the branch ending at the selected AI message into a new conversation."""
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=payload.messageId)
    branch = build_message_lineage(current_conv.messages, payload.messageId)

    async with logged_db_operation(
        logger=logger,
        db=db,
        success_event=None,
        failure_event="conversation_fork_failed",
        success_message="Conversation forked",
        failure_message="Conversation fork failed",
        source_conversation_id=conversation_id,
        forked_message_id=payload.messageId,
        branch_message_count=len(branch),
    ) as operation:
        forked_conv = await clone_branch_to_conversation(
            db=db,
            source_conv=current_conv,
            branch=branch,
            forked_message_id=payload.messageId,
        )
        await db.commit()
        operation.add(forked_conversation_id=forked_conv.id)
    # The agent's files come along — paths only; the agents service shares the bytes.
    await copy_conversation_files(user_id, conversation_id, forked_conv.id)

    forked_full = await get_conversation_with_agent(db, forked_conv.id)
    logger.info("conversation_forked", "Conversation forked", **operation.snapshot())
    return ConversationSummary.model_validate(forked_full)


@router.post(
    "/{user_id}/{conversation_id}/share",
    response_model=ConversationShareResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a read-only share snapshot for a conversation branch",
)
async def shareConversation(
    user_id: str,
    conversation_id: str,
    payload: ConversationShareIn,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    # Mints a public token — outward-facing artifact, per-user ceiling.
    # After auth + CSRF on purpose: the bucket is keyed on the path's {user_id},
    # so it must only ever count requests that user actually made.
    _rate_limited: None = Depends(share_create_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId_full),
    db: AsyncSession = Depends(get_db),
):
    """Create a public read-only snapshot link ending at the selected AI message."""
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=payload.messageId)
    branch = build_message_lineage(current_conv.messages, payload.messageId)
    snapshot_messages = select_scoped_messages(current_conv, payload.messageId, payload.mode, payload.branchPath)
    if not snapshot_messages:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found in conversation.")
    snapshot = build_share_snapshot(current_conv, snapshot_messages)
    snapshot["shareMode"] = payload.mode
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    expires_at = resolve_share_expires_at(payload.expiresAt, now)

    async with logged_db_operation(
        logger=logger,
        db=db,
        success_event=None,
        failure_event="conversation_share_failed",
        success_message="Conversation share created",
        failure_message="Conversation share failed",
        source_conversation_id=conversation_id,
        shared_message_id=payload.messageId,
        share_mode=payload.mode,
        branch_message_count=len(branch),
        snapshot_message_count=len(snapshot_messages),
    ) as operation:
        share = ConversationShareTable(
            token=token_urlsafe(32),
            conversation_id=conversation_id,
            owner_user_id=current_user.id,
            snapshot_until_message_id=payload.messageId,
            title=current_conv.title,
            snapshot_json=snapshot,
            is_active=True,
            expires_at=expires_at,
            created_at=now,
            updated_at=now,
        )
        db.add(share)
        await db.commit()
        operation.add(share_id=share.id)

    logger.info("conversation_share_created", "Conversation share created", **operation.snapshot())
    return ConversationShareResponse(
        id=share.id,
        token=share.token,
        shareUrl=f"/share/{share.token}",
        conversationId=conversation_id,
        messageId=payload.messageId,
        shareMode=payload.mode,
        title=current_conv.title,
        isActive=share.is_active,
        revokedAt=share.revoked_at,
        expiresAt=share.expires_at,
        createdAt=share.created_at,
    )


@router.post(
    "/{user_id}/{conversation_id}/share/export-pdf",
    summary="Create a transient PDF export for a conversation share scope",
)
async def exportConversationPdf(
    user_id: str,
    conversation_id: str,
    payload: ConversationPdfExportIn,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    # Full-conversation server-side render — CPU/memory heavy, per-user ceiling.
    # After auth + CSRF on purpose: the bucket is keyed on the path's {user_id},
    # so it must only ever count requests that user actually made.
    _rate_limited: None = Depends(export_pdf_rate_limit),
    current_conv: ConversationTable = Depends(validate_convId_full),
):
    """Return a generated PDF for the requested share scope without persisting it."""
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=payload.messageId)
    messages = select_scoped_messages(current_conv, payload.messageId, payload.mode, payload.branchPath)
    if not messages:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found in conversation.")

    pdf_bytes = render_conversation_pdf(current_conv, messages, payload.mode)
    filename = conversation_pdf_filename(current_conv, payload.mode)
    logger.info(
        "conversation_pdf_exported",
        "Conversation PDF export generated",
        user_id=current_user.id,
        conversation_id=conversation_id,
        export_mode=payload.mode,
        message_count=len(messages),
        pdf_size=len(pdf_bytes),
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": encode_disposition(filename, "attachment"),
            "Content-Length": str(len(pdf_bytes)),
            "Cache-Control": "no-store",
        },
    )


@router.delete(
    "/{user_id}/{conversation_id}/share/{share_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Revoke a conversation share link",
)
async def revokeConversationShare(
    user_id: str,
    conversation_id: str,
    share_id: str,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Revoke a share link owned by the authenticated conversation owner."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    share = await get_share_for_owner(db, share_id, current_conv.id, current_user.id)
    if share is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found.")

    share.is_active = False
    share.revoked_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await db.commit()
    logger.info("conversation_share_revoked", "Conversation share revoked", share_id=share_id)
    return


@router.get(
    "/{user_id}",
    response_model=Page[ConversationSummary],
    status_code=status.HTTP_200_OK,
    summary="Get paginated conversation summaries for the user",
)
async def getConvsSummary(
    user_id: str,
    current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db)
):
    """
    Return a paginated conversation summary list for the user.
    Use query params: ?page=1&size=50
    """
    set_context(user_id=user_id)
    page = await apaginate(db, conversation_summaries_query(user_id, archived=False))
    logger.info("conversation_summary_list_fetched", "Conversation summary list fetched", total=page.total, page=page.page, size=page.size)
    return page


@router.get(
    "/{user_id}/archived",
    response_model=Page[ConversationSummary],
    status_code=status.HTTP_200_OK,
    summary="Get paginated archived conversation summaries for the user",
)
async def getArchivedConvsSummary(
    user_id: str,
    current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db)
):
    """
    Return a paginated archived conversation summary list for the user.
    """
    set_context(user_id=user_id)
    page = await apaginate(db, conversation_summaries_query(user_id, archived=True))
    logger.info("conversation_archived_summary_list_fetched", "Archived conversation summary list fetched", total=page.total, page=page.page, size=page.size)
    return page


@router.get(
    "/{user_id}/pinned",
    response_model=Page[ConversationSummary],
    status_code=status.HTTP_200_OK,
    summary="Get paginated pinned conversation summaries for the user",
)
async def getPinnedConvsSummary(
    user_id: str,
    current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db)
):
    """
    Return the user's pinned conversations, newest pin first. The pin cap keeps
    this to one page, so the sidebar loads it whole next to the first page of Chats.
    """
    set_context(user_id=user_id)
    page = await apaginate(db, conversation_summaries_query(user_id, pinned=True))
    logger.info("conversation_pinned_summary_list_fetched", "Pinned conversation summary list fetched", total=page.total, page=page.page, size=page.size)
    return page


@router.get(
    "/{user_id}/shares",
    response_model=list[ConversationShareListItem],
    status_code=status.HTTP_200_OK,
    summary="Get paginated shared conversation links for the user",
)
async def getConversationShares(
    user_id: str,
    page: int = Query(1, ge=1),
    size: int = Query(10, ge=1, le=50),
    current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """Return share links owned by the authenticated user."""
    set_context(user_id=user_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    shares = await list_owned_shares(db, current_user.id, page, size)
    logger.info(
        "conversation_share_list_fetched",
        "Conversation share list fetched",
        count=len(shares),
        page=page,
        size=size,
    )
    return [build_share_list_item(share, now) for share in shares]


@router.get(
    "/{user_id}/{conversation_id}",
    response_model=ConversationDetail,
    status_code=status.HTTP_200_OK,
    summary="Get one conversation (messages included) by user + conversation id",
)
async def getConvDetails(
    user_id: str,
    conversation_id: str,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
):
    """Fetch one conversation (messages included) by user + conversation id."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    # Log a custom event with the conversation id and number of messages, for better observability of conversation engagement
    logger.info("conversation_details_fetched", "Conversation details fetched", conversation_id=conversation_id, message_count=len(current_conv.messages))
    return ConversationDetail.model_validate(current_conv)


@router.delete(
    "/{user_id}/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a conversation by user + conversation id"
)
async def deleteConversation(
    user_id: str,
    conversation_id: str,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Delete a conversation entirely (cascades to messages & attachments rows)."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    # The agents service's threads and files go too: noted in this transaction
    # (it reads the thread ids off the messages, so before they are gone), then
    # sent once committed. A failed send is retried later; never blocks delete.
    await enqueue_runtime_reap(db, user_id, conversation_id)
    await db.delete(current_conv)
    await db.commit()
    logger.info("conversation_deleted", "Conversation deleted", conversation_id=conversation_id, agent_id=current_conv.agent_id)
    await drain_runtime_reaps()
    return


@router.patch(
    "/{user_id}/{conversation_id}/title",
    response_model=ConversationSummary,
    status_code=status.HTTP_200_OK,
    summary="Update a conversation title",
)
async def renameConversation(
    user_id: str,
    conversation_id: str,
    payload: ConversationTitleUpdate,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Rename an existing conversation and return the refreshed summary."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    current_conv.title = payload.title
    await db.commit()
    await db.refresh(current_conv, attribute_names=["title", "updated_at", "last_message_preview", "agent"])
    logger.info("conversation_renamed", "Conversation title updated", title_length=len(_preview(payload.title)), new_title=_preview(payload.title), conversation_id=conversation_id, agent_id=current_conv.agent_id)
    return ConversationSummary.model_validate(current_conv)


@router.patch(
    "/{user_id}/{conversation_id}/archive",
    response_model=ConversationSummary,
    status_code=status.HTTP_200_OK,
    summary="Archive a conversation",
)
async def archiveConversation(
    user_id: str,
    conversation_id: str,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Archive an existing conversation and return the refreshed summary."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await set_conversation_archive_state(db, current_conv, True)
    logger.info("conversation_archived", "Conversation archived", conversation_id=conversation_id, agent_id=current_conv.agent_id)
    return ConversationSummary.model_validate(current_conv)


@router.patch(
    "/{user_id}/{conversation_id}/unarchive",
    response_model=ConversationSummary,
    status_code=status.HTTP_200_OK,
    summary="Unarchive a conversation",
)
async def unarchiveConversation(
    user_id: str,
    conversation_id: str,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Unarchive an existing conversation and return the refreshed summary."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await set_conversation_archive_state(db, current_conv, False)
    logger.info("conversation_unarchived", "Conversation unarchived", conversation_id=conversation_id, agent_id=current_conv.agent_id)
    return ConversationSummary.model_validate(current_conv)


@router.patch(
    "/{user_id}/{conversation_id}/pin",
    response_model=ConversationSummary,
    status_code=status.HTTP_200_OK,
    summary="Pin a conversation to the top of the sidebar",
)
async def pinConversation(
    user_id: str,
    conversation_id: str,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Pin a conversation and return the refreshed summary (409 past the pin cap)."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await set_conversation_pin_state(db, current_conv, True)
    logger.info("conversation_pinned", "Conversation pinned", conversation_id=conversation_id, agent_id=current_conv.agent_id)
    return ConversationSummary.model_validate(current_conv)


@router.patch(
    "/{user_id}/{conversation_id}/unpin",
    response_model=ConversationSummary,
    status_code=status.HTTP_200_OK,
    summary="Unpin a conversation",
)
async def unpinConversation(
    user_id: str,
    conversation_id: str,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Unpin a conversation and return the refreshed summary."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await set_conversation_pin_state(db, current_conv, False)
    logger.info("conversation_unpinned", "Conversation unpinned", conversation_id=conversation_id, agent_id=current_conv.agent_id)
    return ConversationSummary.model_validate(current_conv)


@router.patch(
    "/{user_id}/{conversation_id}/visibility",
    response_model=ConversationSummary,
    status_code=status.HTTP_200_OK,
    summary="Save a private conversation as a normal one",
)
async def saveConversationVisibility(
    user_id: str,
    conversation_id: str,
    payload: ConversationVisibilityUpdate,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Make a private conversation normal ("Save chat"): it joins the chat list,
    search, suggestions, memory and Usage. One-way; 409 when it is already saved."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    queued = await save_private_conversation(db, current_conv)
    logger.info(
        "conversation_saved_from_private",
        "Private conversation saved",
        conversation_id=conversation_id,
        agent_id=current_conv.agent_id,
        queued_for_embedding=queued,
    )
    return ConversationSummary.model_validate(current_conv)


@router.post(
    "/{user_id}/{conversation_id}/report",
    response_model=ConversationSummary,
    status_code=status.HTTP_200_OK,
    summary="Report a conversation with an optional specific message target",
)
async def reportConversation(
    user_id: str,
    conversation_id: str,
    payload: ConversationReportIn,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """Create a report for a conversation, optionally scoped to a specific message."""
    set_context(user_id=user_id, conversation_id=conversation_id)

    if current_conv.is_reported:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation has already been reported.",
        )

    resolved_message_id = payload.messageId
    if resolved_message_id:
        target_message = await get_owned_message(
            db, conversation_id, resolved_message_id, with_attachments=False
        )
        if target_message is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Reported message does not belong to this conversation.",
            )

    report = ConversationReportTable(
        conversation_id=conversation_id,
        user_id=current_user.id,
        message_id=resolved_message_id,
        reason=payload.reason,
        details=payload.details,
    )
    db.add(report)

    current_conv.is_reported = True
    current_conv.reported_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await db.commit()
    await db.refresh(
        current_conv,
        attribute_names=[
            "title",
            "updated_at",
            "last_message_preview",
            "agent",
            "is_reported",
            "reported_at",
            "is_archived",
            "archived_at",
        ],
    )
    logger.info(
        "conversation_reported",
        "Conversation reported",
        conversation_id=conversation_id,
        agent_id=current_conv.agent_id,
        message_id=resolved_message_id,
        reason=payload.reason,
    )
    return ConversationSummary.model_validate(current_conv)


@router.post(
    "/{user_id}/{conversation_id}/compact",
    response_model=CompactConversationOut,
    status_code=status.HTTP_200_OK,
    summary="Compact the conversation's context now, after the given answer",
)
async def compactConversation(
    user_id: str,
    conversation_id: str,
    payload: CompactConversationIn,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    _limit: None = Depends(compaction_rate_limit),
    db: AsyncSession = Depends(get_db),
):
    """Summarize the branch's older messages so the agent works from a smaller
    context (plan 34). The rate limit sits after auth and CSRF: it keys on
    the path's user id, which is only trustworthy once validated."""
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=payload.messageId)
    message = await compact_conversation(
        db, user_id=current_user.id, conversation=current_conv, message_id=payload.messageId
    )
    if message is None:
        return CompactConversationOut(status="nothing_to_compact")
    fresh = await get_owned_message(db, conversation_id, message.id)
    return CompactConversationOut(status="compacted", message=MessageOut.model_validate(fresh))


@router.post(
    "/{user_id}/{conversation_id}/compact/undo",
    response_model=MessageOut,
    status_code=status.HTTP_200_OK,
    summary="Undo the compaction recorded on the given answer",
)
async def undoConversationCompaction(
    user_id: str,
    conversation_id: str,
    payload: CompactConversationIn,
    current_user: AuthUser = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    _: None = Depends(require_csrf_protection),
    _limit: None = Depends(compaction_rate_limit),
    db: AsyncSession = Depends(get_db),
):
    """Restore the agent's state from before a manual compaction, while nothing
    was sent after it."""
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=payload.messageId)
    message = await undo_conversation_compaction(
        db, user_id=current_user.id, conversation=current_conv, message_id=payload.messageId
    )
    fresh = await get_owned_message(db, conversation_id, message.id)
    return MessageOut.model_validate(fresh)
