import asyncio
from urllib.parse import quote

from fastapi import HTTPException, Response, status
from fastapi.responses import StreamingResponse
from observability import StreamMetrics, get_context, get_logger, set_context
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable


logger = get_logger(__name__)


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
        base_headers["Cache-Control"] = "private, max-age=300"

    chunk_size = 1024 * 512

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
