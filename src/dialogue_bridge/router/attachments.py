from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi_pagination import Page, Params
from observability import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db, UserTable
from core.settings import settings
from schemas import DocxPreviewTokenOut, ImageOut
from utils import validate_userId
from utils.attachments import (
    _get_attachment_blob_row,
    encode_disposition,
    generate_docx_preview_token,
    get_public_docx_blob,
    list_user_images,
    stream_blob_response,
    validate_docx_preview_token,
)


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
    "/preview-token/{user_id}/{conversation_id}/{message_id}/{blob_id}",
    response_model=DocxPreviewTokenOut,
    summary="Issue a short-lived token for Microsoft Office Online Viewer access",
)
async def getDocxPreviewToken(
    user_id: str,
    conversation_id: str,
    message_id: str,
    blob_id: str,
    _current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    set_context(user_id=user_id)
    await _get_attachment_blob_row(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        blob_id=blob_id,
        db=db,
        include_data=False,
    )
    ttl = settings.attachments.docx_preview_token_ttl_seconds
    token = generate_docx_preview_token(
        blob_id,
        settings.session.token_secret.get_secret_value(),
        ttl=ttl,
    )
    logger.info("docx_preview_token_issued", "Issued DOCX preview token", blob_id=blob_id)
    return DocxPreviewTokenOut(token=token, expiresIn=ttl)


@router.get(
    "/public/{token}",
    summary="Serve raw DOCX blob for Microsoft Office Online Viewer (token-authenticated, no session required)",
)
async def getPublicBlobForViewer(token: str, db: AsyncSession = Depends(get_db)):
    blob_id = validate_docx_preview_token(token, settings.session.token_secret.get_secret_value())
    if not blob_id:
        raise HTTPException(status_code=401, detail="Preview link is invalid or has expired.")

    row = await get_public_docx_blob(db, blob_id)
    if not row:
        raise HTTPException(status_code=404, detail="Blob not found.")

    logger.info("docx_public_blob_served", "Served DOCX blob for Office Viewer", blob_id=blob_id)
    return Response(
        content=row["data"],
        media_type=row["mime_type"],
        headers={
            "Content-Disposition": encode_disposition(row["file_name"], "inline"),
            "Cache-Control": "no-store",
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
    page = await list_user_images(db, user_id, params)
    logger.info("images_page_fetched", "Fetched paginated user images", item_count=len(page.items), total=page.total, page=params.page, size=params.size)
    return page


