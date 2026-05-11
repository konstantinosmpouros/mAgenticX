from fastapi import APIRouter, Depends, Header, Response, status
from fastapi_pagination import Page, Params, create_page
from observability import get_logger, set_context
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable, get_db, UserTable
from schemas import ImageOut
from utils import validate_userId
from utils.attachments import convert_attachment_to_pdf_preview, encode_disposition, stream_blob_response


router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/download/{user_id}/{conversation_id}/{message_id}/{blob_id}",
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
    return await stream_blob_response(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        blob_id=blob_id,
        range_header=range_header,
        db=db,
        disposition="attachment",
    )


@router.get(
    "/preview/{user_id}/{conversation_id}/{message_id}/{blob_id}",
    summary="Stream a non-image blob inline for in-app preview with HTTP byte-range support",
)
async def previewBlobInline(
    user_id: str,
    conversation_id: str,
    message_id: str,
    blob_id: str,
    _current_user: UserTable = Depends(validate_userId),
    range_header: str | None = Header(default=None, alias="Range"),
    db: AsyncSession = Depends(get_db),
):
    return await stream_blob_response(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        blob_id=blob_id,
        range_header=range_header,
        db=db,
        disposition="inline",
    )


@router.get(
    "/preview-derived/{user_id}/{conversation_id}/{message_id}/{blob_id}",
    summary="Convert a PowerPoint attachment to inline PDF for secure in-app preview",
)
async def previewBlobDerivedInline(
    user_id: str,
    conversation_id: str,
    message_id: str,
    blob_id: str,
    _current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    pdf_bytes, preview_name = await convert_attachment_to_pdf_preview(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        blob_id=blob_id,
        db=db,
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": encode_disposition(preview_name, "inline"),
            "Content-Length": str(len(pdf_bytes)),
        },
    )


@router.get(
    "/images/{user_id}",
    response_model=Page[ImageOut],
    status_code=status.HTTP_200_OK,
    summary="Get paginated images for the user",
)
async def getImagesBatch(
    user_id: str,
    current_user: UserTable = Depends(validate_userId),
    params: Params = Depends(),
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
            func.replace(func.encode(BlobTable.data, "base64"), "\n", "").label("data_b64"),
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

    raw_params = params.to_raw_params()
    paged_stmt = (
        stmt.add_columns(func.count().over().label("total_count"))
        .limit(raw_params.limit)
        .offset(raw_params.offset)
    )
    result = await db.execute(paged_stmt)
    rows = result.all()
    total = rows[0].total_count if rows else 0

    items = [
        ImageOut(
            blob_id=r.blob_id,
            attachment_id=r.attachment_id,
            file_name=r.file_name,
            mime_type=r.mime_type,
            created_at=r.created_at,
            dataB64=r.data_b64,
        )
        for r in rows
    ]
    logger.info("images_page_fetched", "Fetched paginated user images", item_count=len(items), total=total, page=params.page, size=params.size)

    return create_page(items, total=total, params=params)


