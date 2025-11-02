import base64
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from fastapi_pagination import Page
from fastapi_pagination.ext.sqlalchemy import paginate
from sqlalchemy import desc, func, select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import AttachmentTable, BlobTable, ConversationTable, MessageTable, get_db, UserTable
from database.schemas import (
    ConversationDetail,
    ConversationIn,
    ConversationSummary,
    CreateConversationResponse,
    ImageOut,
    MessageIn,
    MessageOut,
    UpdateConversationResponse,
)
from utils import (
    _preview,
    init_conv,
    init_message,
    validate_agentId,
    validate_convId,
    validate_convId_full,
    validate_userId,
)

router = APIRouter(
    prefix="/users/{user_id}",
    tags=["Conversations", "Messages", "Attachments", "Images"],
)


@router.post(
    "/conversations",
    response_model=CreateConversationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["Conversations"],
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
    # Validate agent
    agent = await validate_agentId(db, payload.agentId)
    
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
    tags=["Conversations"],
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
    tags=["Conversations"],
)
async def getConvDetails(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
):
    """Fetch one conversation (messages included) by user + conversation id."""
    return ConversationDetail.model_validate(current_conv)


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}/blobs/{blob_id}",
    tags=["Attachments"],
)
async def downloadBlobStream(
    user_id: str,
    conversation_id: str,
    message_id: str,
    blob_id: str,
    _current_user: UserTable = Depends(validate_userId),
    range_header: str | None = Header(default=None, alias="Range"),
    db: AsyncSession = Depends(get_db),
):
    """
    Stream a blob (non-image) with HTTP byte-range support.
    Returns 200 for full content or 206 for partial content.
    """
    # Validate ownership and get data + metadata
    result = await db.execute(
        select(
            AttachmentTable.mime_type,
            AttachmentTable.file_name,
            func.coalesce(
                AttachmentTable.size_bytes,
                func.octet_length(BlobTable.data)
            ).label("blob_size"),
        )
        .select_from(BlobTable)
        .join(AttachmentTable, AttachmentTable.blob_id == BlobTable.id)
        .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            BlobTable.id == blob_id,
            AttachmentTable.message_id == message_id,
            MessageTable.id == message_id,
            MessageTable.conversation_id == conversation_id,
            ConversationTable.id == conversation_id,
            ConversationTable.user_id == user_id,
        )
    )
    row = result.mappings().one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Blob not found or not accessible.")

    mime: str | None = row["mime_type"]
    file_name: str | None = row["file_name"]
    file_size: int | None = row["blob_size"]

    if mime and mime.startswith("image/"):
        raise HTTPException(status_code=400, detail="Images are not served by this endpoint.")

    if file_size is None:
        raise HTTPException(status_code=500, detail="Unable to determine blob size.")

    def encode_disposition(name: str | None) -> str:
        name = name or "download"
        try:
            name.encode("ascii")
            return f'attachment; filename="{name}"'
        except Exception:
            from urllib.parse import quote
            return f"attachment; filename*=UTF-8''{quote(name)}"

    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": encode_disposition(file_name),
    }

    CHUNK = 1024 * 512

    async def stream_range(start: int, end: int):
        pos = start
        while pos <= end:
            length = min(CHUNK, end - pos + 1)
            chunk_result = await db.execute(
                select(func.substring(BlobTable.data, pos + 1, length))
                .select_from(BlobTable)
                .where(BlobTable.id == blob_id)
            )
            chunk = chunk_result.scalar_one_or_none()
            if not chunk:
                break
            if isinstance(chunk, memoryview):
                chunk = chunk.tobytes()
            else:
                chunk = bytes(chunk)
            yield chunk
            pos += len(chunk)
    
    # Full content
    if not range_header:
        headers = dict(base_headers)
        headers["Content-Length"] = str(file_size)
        return StreamingResponse(
            stream_range(0, file_size - 1),
            media_type=mime or "application/octet-stream",
            headers=headers,
        )
    
    # Parse Range: bytes=start-end
    try:
        units, rng = range_header.split("=")
        if units.strip().lower() != "bytes":
            raise ValueError
        start_s, end_s = [s.strip() for s in rng.split("-")]
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
        if start > end or start < 0 or end >= file_size:
            raise ValueError
    except Exception:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
    
    content_length = end - start + 1
    headers = dict(base_headers)
    headers.update({
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(content_length),
    })
    
    return StreamingResponse(
        stream_range(start, end),
        status_code=206,
        media_type=mime or "application/octet-stream",
        headers=headers,
    )


@router.get(
    "/images",
    response_model=Page[ImageOut],
    status_code=status.HTTP_200_OK,
    tags=["Images"],
)
async def getImagesBatch(
    user_id: str,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """
    Paginated image retrieval for a user. Use query params `page` and `size`.
    Returns base64-encoded image data with metadata. The `total` field on the
    Page response can be used instead of a separate summary endpoint.
    """
    stmt = (
        select(
            BlobTable.id.label("blob_id"),
            AttachmentTable.id.label("attachment_id"),
            AttachmentTable.file_name,
            AttachmentTable.mime_type,
            AttachmentTable.created_at,
            BlobTable.data,
        )
        .join(AttachmentTable, AttachmentTable.blob_id == BlobTable.id)
        .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            ConversationTable.user_id == user_id,
            AttachmentTable.mime_type.like("image/%"),
        )
        .order_by(desc(AttachmentTable.created_at))
    )

    pages = await paginate(db, stmt)

    items = [
        ImageOut(
            blob_id=r.blob_id,
            attachment_id=r.attachment_id,
            file_name=r.file_name,
            mime_type=r.mime_type,
            created_at=r.created_at,
            dataB64=base64.b64encode(r.data).decode(),
        )
        for r in pages.items
    ]

    return Page[ImageOut](items=items, total=pages.total, page=pages.page, size=pages.size)


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=UpdateConversationResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["Messages"],
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
    try:
        # 1) Persist the new message and capture it
        msg = await init_message(db, current_conv, payload)
        
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
    await db.refresh(current_conv)
    summary = ConversationSummary.model_validate(current_conv)
    
    return UpdateConversationResponse(message=message_out, summary=summary)


@router.post(
    "/conversations/{conversation_id}/messages/{message_id}/like",
    response_model=MessageOut,
    status_code=status.HTTP_200_OK,
    tags=["Messages"],
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
    tags=["Messages"],
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


@router.delete(
    "/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["Conversations"],
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
