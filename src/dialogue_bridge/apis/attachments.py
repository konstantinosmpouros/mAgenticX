import base64
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from fastapi_pagination import Page
from fastapi_pagination.ext.sqlalchemy import paginate
from observability import log_event, set_context
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import AttachmentTable, BlobTable, ConversationTable, MessageTable, get_db, UserTable
from database.schemas import ImageOut
from utils import validate_userId


router = APIRouter(prefix="/users/{user_id}", tags=["Attachments"])
logger = logging.getLogger(__name__)


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}/blobs/{blob_id}",
    summary="Stream a blob (non-image) with HTTP byte-range support",
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
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=message_id)
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

    async def stream_range(start: int, end: int, *, partial: bool):
        pos = start
        served_bytes = 0
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
            served_bytes += len(chunk)
            yield chunk
            pos += len(chunk)
        log_event(
            logger,
            logging.INFO,
            "blob_download_completed",
            "Blob download completed",
            blob_id=blob_id,
            file_name=file_name,
            file_size=file_size,
            partial=partial,
            served_bytes=served_bytes,
        )
    
    # Full content
    if not range_header:
        headers = dict(base_headers)
        headers["Content-Length"] = str(file_size)
        log_event(
            logger,
            logging.INFO,
            "blob_download_started",
            "Blob download started",
            blob_id=blob_id,
            file_name=file_name,
            file_size=file_size,
            partial=False,
        )
        return StreamingResponse(
            stream_range(0, file_size - 1, partial=False),
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
        log_event(
            logger,
            logging.WARNING,
            "blob_range_invalid",
            "Blob download received an invalid range header",
            blob_id=blob_id,
            range_header=range_header,
            file_size=file_size,
        )
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
    
    content_length = end - start + 1
    headers = dict(base_headers)
    headers.update({
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(content_length),
    })
    log_event(
        logger,
        logging.INFO,
        "blob_download_started",
        "Blob partial download started",
        blob_id=blob_id,
        file_name=file_name,
        file_size=file_size,
        partial=True,
        range_start=start,
        range_end=end,
    )
    
    return StreamingResponse(
        stream_range(start, end, partial=True),
        status_code=206,
        media_type=mime or "application/octet-stream",
        headers=headers,
    )


@router.get(
    "/images",
    response_model=Page[ImageOut],
    status_code=status.HTTP_200_OK,
    summary="Get paginated images for the user",
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
    set_context(user_id=user_id)
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
    log_event(
        logger,
        logging.INFO,
        "images_page_fetched",
        "Fetched paginated user images",
        user_id=user_id,
        item_count=len(items),
        total=pages.total,
        page=pages.page,
        size=pages.size,
    )

    return Page[ImageOut](items=items, total=pages.total, page=pages.page, size=pages.size)


