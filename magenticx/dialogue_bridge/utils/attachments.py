import asyncio
import base64
import hashlib
import hmac
import time
from urllib.parse import quote

from fastapi import HTTPException, Response, status
from fastapi.responses import StreamingResponse
from fastapi_pagination import Page, Params, create_page
from core.logging import StreamMetrics, get_context, get_logger, set_context
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable
from core.settings import settings
from schema import ImageOut


logger = get_logger(__name__)


# File types the Microsoft Office Online viewer handles — the only types for
# which a public, session-less preview token may be minted. Anything else
# (notably text/html) must never be served inline from the public endpoint.
# Keyed by extension because the stored MIME is whatever the browser reported at
# upload (often non-canonical — octet-stream / x-zip — for OOXML files), so the
# extension is the reliable signal and mirrors how the UI routes previews.
OFFICE_PREVIEW_MIME_BY_EXT = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
OFFICE_PREVIEW_MIMES = frozenset(OFFICE_PREVIEW_MIME_BY_EXT.values())


def generate_docx_preview_token(
    blob_id: str, mime: str, secret: str, ttl: int = settings.attachments.docx_preview_token_ttl_seconds
) -> str:
    expiry = int(time.time()) + ttl
    payload = f"{blob_id}:{mime}:{expiry}"
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    raw = f"{payload}:{sig}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def validate_docx_preview_token(token: str, secret: str) -> tuple[str, str] | None:
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        blob_id, mime, expiry_str, sig = raw.rsplit(":", 3)
        if int(expiry_str) < time.time():
            return None
        payload = f"{blob_id}:{mime}:{expiry_str}"
        expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        if mime.lower() not in OFFICE_PREVIEW_MIMES:
            return None
        return blob_id, mime
    except Exception:
        return None


async def _get_attachment_blob_row(
    *,
    user_id: str,
    conversation_id: str,
    message_id: str,
    blob_id: str,
    db: AsyncSession,
    include_data: bool = False,
):
    columns = [
        AttachmentTable.mime_type,
        AttachmentTable.file_name,
        func.coalesce(
            AttachmentTable.size_bytes,
            func.length(BlobTable.data),
        ).label("blob_size"),
    ]
    if include_data:
        columns.append(BlobTable.data.label("blob_data"))

    result = await db.execute(
        select(*columns)
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
    return row


def encode_disposition(name: str | None, disposition: str) -> str:
    fallback_name = "document.pdf" if disposition == "inline" else "download"
    safe_name = (name or fallback_name).replace("\\", "_").replace("/", "_").replace('"', "'").strip() or fallback_name
    ascii_name = safe_name.encode("ascii", "ignore").decode("ascii").strip() or fallback_name
    encoded_name = quote(safe_name)
    return f'{disposition}; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded_name}'


async def stream_blob_response(
    *,
    user_id: str,
    conversation_id: str,
    message_id: str,
    blob_id: str,
    range_header: str | None,
    db: AsyncSession,
    disposition: str,
    require_pdf: bool = False,
):
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=message_id)
    request_context = get_context()

    row = await _get_attachment_blob_row(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        blob_id=blob_id,
        db=db,
    )

    mime: str | None = row["mime_type"]
    file_name: str | None = row["file_name"]
    file_size: int | None = row["blob_size"]

    if mime and mime.startswith("image/"):
        raise HTTPException(status_code=400, detail="Images are not served by this endpoint.")

    if require_pdf and mime != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDFs are served by this preview endpoint.")

    if file_size is None:
        logger.error(
            "blob_size_unavailable",
            "Blob size could not be determined before streaming",
            context=request_context,
            blob_id=blob_id,
            disposition=disposition,
            failure_reason="blob_size_unavailable",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The attachment could not be prepared for download. Please try again.",
        )

    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": encode_disposition(file_name, disposition),
    }
    if disposition == "inline":
        base_headers["Cache-Control"] = f"private, max-age={settings.attachments.inline_cache_max_age_seconds}"

    chunk_size = settings.attachments.stream_chunk_bytes

    async def stream_range(start: int, end: int, *, partial: bool):
        metrics = StreamMetrics()
        pos = start
        completed = False
        caught_exc: BaseException | None = None
        try:
            while pos <= end:
                length = min(chunk_size, end - pos + 1)
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
                yield metrics.track(chunk)
                pos += len(chunk)
            completed = True
        except BaseException as exc:
            caught_exc = exc
            raise
        finally:
            common = dict(
                blob_id=blob_id,
                file_size=file_size,
                partial=partial,
                served_bytes=metrics.bytes_forwarded,
                chunk_count=metrics.chunk_count,
                first_byte_latency_ms=metrics.first_byte_latency_ms,
                total_stream_duration_ms=metrics.snapshot()["total_stream_duration_ms"],
                disposition=disposition,
            )
            if completed:
                logger.info("blob_download_completed", "Blob download completed", context=request_context, **common)
            elif isinstance(caught_exc, (asyncio.CancelledError, GeneratorExit)):
                logger.warning("blob_download_aborted", "Blob download aborted by client", context=request_context, **common)
            else:
                logger.error(
                    "blob_download_error",
                    "Blob download failed",
                    exc_info=True,
                    context=request_context,
                    error=str(caught_exc) if caught_exc else None,
                    **common,
                )

    if not range_header:
        headers = dict(base_headers)
        headers["Content-Length"] = str(file_size)
        logger.info(
            "blob_download_started",
            "Blob download started",
            context=request_context,
            blob_id=blob_id,
            file_size=file_size,
            partial=False,
            disposition=disposition,
        )
        return StreamingResponse(
            stream_range(0, file_size - 1, partial=False),
            media_type=mime or "application/octet-stream",
            headers=headers,
        )

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
        logger.warning(
            "blob_range_invalid",
            "Blob download received an invalid range header",
            context=request_context,
            blob_id=blob_id,
            range_header=range_header,
            file_size=file_size,
            disposition=disposition,
        )
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    content_length = end - start + 1
    headers = dict(base_headers)
    headers.update({
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(content_length),
    })
    logger.info(
        "blob_download_started",
        "Blob partial download started",
        context=request_context,
        blob_id=blob_id,
        file_size=file_size,
        partial=True,
        range_start=start,
        range_end=end,
        disposition=disposition,
    )

    return StreamingResponse(
        stream_range(start, end, partial=True),
        status_code=206,
        media_type=mime or "application/octet-stream",
        headers=headers,
    )


async def get_public_docx_blob(db: AsyncSession, blob_id: str):
    """Load the raw bytes + display metadata for a token-authenticated DOCX viewer request."""
    result = await db.execute(
        select(BlobTable.data, AttachmentTable.file_name, AttachmentTable.mime_type)
        .join(AttachmentTable, AttachmentTable.blob_id == BlobTable.id)
        .where(BlobTable.id == blob_id)
    )
    return result.mappings().one_or_none()


async def list_user_images(db: AsyncSession, user_id: str, params: Params) -> Page[ImageOut]:
    """Return a page of the user's image attachments with base64-encoded payloads."""
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
    return create_page(items, total=total, params=params)
