from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi_pagination import Page, Params
from observability import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.auth_session import AuthUser
from core.settings import settings
from schemas import DocxPreviewTokenOut, ImageOut
from utils import validate_userId
from utils.attachments import (
    _get_attachment_blob_row,
    OFFICE_PREVIEW_MIMES,
    OFFICE_PREVIEW_MIME_BY_EXT,
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
    _current_user: AuthUser = Depends(validate_userId),
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
    _current_user: AuthUser = Depends(validate_userId),
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
    _current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    set_context(user_id=user_id)
    row = await _get_attachment_blob_row(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        blob_id=blob_id,
        db=db,
        include_data=False,
    )
    # Resolve to a canonical Office MIME by extension first (reliable), falling
    # back to the stored MIME only when it is already canonical — mirrors the
    # UI's "by mime OR extension" preview routing, so a legitimate Office file
    # is never refused just because the browser reported a non-canonical upload
    # MIME (octet-stream / x-zip for OOXML).
    file_name = row["file_name"] or ""
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    stored_mime = (row["mime_type"] or "").lower()
    mime = OFFICE_PREVIEW_MIME_BY_EXT.get(ext) or (stored_mime if stored_mime in OFFICE_PREVIEW_MIMES else None)
    if not mime:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Preview tokens are only issued for Office documents.",
        )
    ttl = settings.attachments.docx_preview_token_ttl_seconds
    token = generate_docx_preview_token(
        blob_id,
        mime,
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
    validated = validate_docx_preview_token(token, settings.session.token_secret.get_secret_value())
    if not validated:
        raise HTTPException(status_code=401, detail="Preview link is invalid or has expired.")
    blob_id, mime = validated

    row = await get_public_docx_blob(db, blob_id)
    if not row:
        raise HTTPException(status_code=404, detail="Blob not found.")

    logger.info("docx_public_blob_served", "Served DOCX blob for Office Viewer", blob_id=blob_id)
    # Serve under the token-bound MIME (already allow-listed to Office types),
    # never the stored mime — with nosniff + a locked-down CSP so the blob can
    # never render as executable HTML on the app origin.
    return Response(
        content=row["data"],
        media_type=mime,
        headers={
            "Content-Disposition": encode_disposition(row["file_name"], "inline"),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox;",
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
    current_user: AuthUser = Depends(validate_userId),
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


