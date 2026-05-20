import asyncio
import base64
import contextlib
import hashlib
import hmac
from pathlib import Path
import tempfile
import time
from urllib.parse import quote

from fastapi import HTTPException, Response, status
from fastapi.responses import StreamingResponse
from observability import StreamMetrics, get_context, get_logger, set_context
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable


logger = get_logger(__name__)

OFFICE_PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024
OFFICE_CONVERSION_TIMEOUT_SECONDS = 45
PRESENTATION_MIME_TYPES = {
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
PRESENTATION_EXTENSIONS = {"ppt", "pptx"}


def _extension_of(name: str | None) -> str:
    if not name:
        return ""
    return Path(name).suffix.lower().lstrip(".")


def is_presentation_previewable(file_name: str | None, mime: str | None) -> bool:
    normalized_mime = (mime or "").strip().lower()
    extension = _extension_of(file_name)
    return normalized_mime in PRESENTATION_MIME_TYPES or extension in PRESENTATION_EXTENSIONS


_DOCX_PREVIEW_TOKEN_TTL = 60


def generate_docx_preview_token(blob_id: str, secret: str, ttl: int = _DOCX_PREVIEW_TOKEN_TTL) -> str:
    expiry = int(time.time()) + ttl
    payload = f"{blob_id}:{expiry}"
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    raw = f"{payload}:{sig}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def validate_docx_preview_token(token: str, secret: str) -> str | None:
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        blob_id, expiry_str, sig = raw.rsplit(":", 2)
        if int(expiry_str) < time.time():
            return None
        payload = f"{blob_id}:{expiry_str}"
        expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        return blob_id
    except Exception:
        return None


def _office_preview_type(file_name: str | None, mime: str | None) -> bool:
    return is_presentation_previewable(file_name, mime)


def _sanitize_preview_filename(name: str | None) -> str:
    source_name = Path(name or "document").name
    stem = Path(source_name).stem.strip() or "document"
    safe_stem = "".join(char if char.isalnum() or char in {"-", "_", "."} else "_" for char in stem).strip("._")
    return f"{safe_stem or 'document'}.pdf"


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


async def convert_attachment_to_pdf_preview(
    *,
    user_id: str,
    conversation_id: str,
    message_id: str,
    blob_id: str,
    db: AsyncSession,
) -> tuple[bytes, str]:
    set_context(user_id=user_id, conversation_id=conversation_id, message_id=message_id)
    request_context = get_context()

    meta_row = await _get_attachment_blob_row(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        blob_id=blob_id,
        db=db,
        include_data=False,
    )

    mime: str | None = meta_row["mime_type"]
    file_name: str | None = meta_row["file_name"]
    file_size: int | None = meta_row["blob_size"]

    if not _office_preview_type(file_name, mime):
        raise HTTPException(status_code=400, detail="Only PowerPoint attachments support derived preview.")

    if file_size is None or file_size <= 0:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The attachment could not be prepared for preview. Please try again.",
        )

    if file_size > OFFICE_PREVIEW_LIMIT_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Preview is unavailable for Office files larger than {OFFICE_PREVIEW_LIMIT_BYTES // 1024 // 1024} MB.",
        )

    data_row = await _get_attachment_blob_row(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        blob_id=blob_id,
        db=db,
        include_data=True,
    )
    blob_data = data_row["blob_data"]

    if isinstance(blob_data, memoryview):
        blob_bytes = blob_data.tobytes()
    else:
        blob_bytes = bytes(blob_data)

    extension = _extension_of(file_name)
    if not extension:
        normalized_mime = (mime or "").strip().lower()
        extension = "pptx" if normalized_mime.endswith("presentationml.presentation") else "ppt"

    output_name = _sanitize_preview_filename(file_name)
    source_stem = Path(output_name).stem
    started_at = time.monotonic()

    try:
        with tempfile.TemporaryDirectory(prefix="attachment-preview-") as temp_dir:
            temp_path = Path(temp_dir)
            input_path = temp_path / f"{source_stem}.{extension}"
            output_dir = temp_path / "output"
            profile_dir = temp_path / "lo-profile"
            output_dir.mkdir()
            profile_dir.mkdir()
            input_path.write_bytes(blob_bytes)

            export_filter = "pdf:impress_pdf_Export"
            command = [
                "soffice",
                "--headless",
                "--nologo",
                "--nodefault",
                "--nolockcheck",
                "--norestore",
                f"-env:UserInstallation={profile_dir.resolve().as_uri()}",
                "--convert-to",
                export_filter,
                "--outdir",
                str(output_dir),
                str(input_path),
            ]

            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=OFFICE_CONVERSION_TIMEOUT_SECONDS,
                )
            except OSError as exc:
                logger.error(
                    "office_preview_communicate_error",
                    "Failed to communicate with Office conversion process",
                    context=request_context,
                    blob_id=blob_id,
                    file_name=file_name,
                    preview_type=preview_type,
                )
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="The attachment could not be prepared for preview. Please try again.",
                ) from exc
            except asyncio.TimeoutError as exc:
                process.kill()
                with contextlib.suppress(Exception):
                    await process.communicate()
                logger.warning(
                    "office_preview_timeout",
                    "Office preview conversion timed out",
                    context=request_context,
                    blob_id=blob_id,
                    file_name=file_name,
                    mime_type=mime,
                    preview_type=preview_type,
                    file_size=file_size,
                    timeout_seconds=OFFICE_CONVERSION_TIMEOUT_SECONDS,
                    conversion_duration_ms=round((time.monotonic() - started_at) * 1000, 2),
                )
                raise HTTPException(
                    status_code=422,
                    detail="Preview conversion timed out for this Office file.",
                ) from exc

            output_path = output_dir / output_name
            if process.returncode != 0 or not output_path.exists():
                logger.warning(
                    "office_preview_failed",
                    "Office preview conversion failed",
                    context=request_context,
                    blob_id=blob_id,
                    file_name=file_name,
                    mime_type=mime,
                    preview_type=preview_type,
                    file_size=file_size,
                    return_code=process.returncode,
                    stdout=stdout.decode("utf-8", errors="ignore")[-2000:],
                    stderr=stderr.decode("utf-8", errors="ignore")[-2000:],
                    conversion_duration_ms=round((time.monotonic() - started_at) * 1000, 2),
                )
                raise HTTPException(
                    status_code=422,
                    detail="Preview conversion failed for this Office file.",
                )

            pdf_bytes = output_path.read_bytes()
            logger.info(
                "office_preview_completed",
                "Office preview conversion completed",
                context=request_context,
                blob_id=blob_id,
                file_name=file_name,
                mime_type=mime,
                preview_type=preview_type,
                file_size=file_size,
                pdf_size=len(pdf_bytes),
                conversion_duration_ms=round((time.monotonic() - started_at) * 1000, 2),
            )
            return pdf_bytes, output_name
    except HTTPException:
        raise
    except PermissionError as exc:
        logger.error(
            "office_preview_permission_error",
            "Permission denied during Office preview conversion",
            context=request_context,
            blob_id=blob_id,
            file_name=file_name,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The attachment could not be prepared for preview. Please try again.",
        ) from exc
    except FileNotFoundError as exc:
        logger.error(
            "office_preview_converter_missing",
            "LibreOffice is not installed for Office preview conversion",
            context=request_context,
            blob_id=blob_id,
            file_name=file_name,
            mime_type=mime,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Office preview is not available on this server.",
        ) from exc
    except Exception as exc:
        logger.error(
            "office_preview_unexpected_error",
            "Office preview conversion failed unexpectedly",
            exc_info=True,
            context=request_context,
            blob_id=blob_id,
            file_name=file_name,
            mime_type=mime,
            file_size=file_size,
            conversion_duration_ms=round((time.monotonic() - started_at) * 1000, 2),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The attachment could not be prepared for preview. Please try again.",
        ) from exc


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
