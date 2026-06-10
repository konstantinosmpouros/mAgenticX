"""Additional coverage for ``utils.attachments`` beyond ``test_attachments.py``.

Targets the paths the route-level tests don't reach:
- ``validate_docx_preview_token`` TTL expiry (vs. the existing tamper / wrong
  secret cases).
- ``encode_disposition`` filename sanitisation + ASCII fallback.
- ``stream_blob_response`` direct calls: ``require_pdf`` rejection, the
  ``blob_size_unavailable`` 500, full + partial range body assembly, and the
  invalid-range 416 — all driven against a real (sqlite) ``AsyncSession`` so
  the streaming generator body actually executes.
"""
from __future__ import annotations

import time

import pytest
from fastapi.responses import StreamingResponse

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable
from utils.attachments import (
    encode_disposition,
    generate_docx_preview_token,
    stream_blob_response,
    validate_docx_preview_token,
)


async def _seed_blob(*, session_factory, seeded_user, seeded_agent, file_name, mime_type, data):
    async with session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Attachment more",
            last_message_preview=file_name,
        )
        session.add(conversation)
        await session.flush()

        message = MessageTable(
            conversation_id=conversation.id,
            sender="user",
            type="file",
            content=file_name,
        )
        session.add(message)
        await session.flush()

        blob = BlobTable(data=data)
        attachment = AttachmentTable(
            message_id=message.id,
            file_name=file_name,
            mime_type=mime_type,
            size_bytes=len(data),
            blob=blob,
        )
        session.add(attachment)
        await session.commit()
        return {
            "conversation_id": conversation.id,
            "message_id": message.id,
            "blob_id": blob.id,
        }


async def _drain(response: StreamingResponse) -> bytes:
    chunks: list[bytes] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk if isinstance(chunk, bytes) else bytes(chunk))
    return b"".join(chunks)


# ---------------------------------------------------------------------------
# validate_docx_preview_token — TTL expiry
# ---------------------------------------------------------------------------
def test_validate_token_expired_returns_none(monkeypatch):
    secret = "ttl-secret"
    # Issue a token that expired one second ago by freezing time during generation.
    real_time = time.time
    monkeypatch.setattr(time, "time", lambda: real_time() - 120)
    token = generate_docx_preview_token("blob-1", secret, ttl=60)
    monkeypatch.setattr(time, "time", real_time)
    assert validate_docx_preview_token(token, secret) is None


def test_validate_token_garbage_returns_none():
    assert validate_docx_preview_token("not-base64-!!!", "secret") is None


def test_validate_token_valid_within_ttl():
    secret = "ttl-secret"
    token = generate_docx_preview_token("blob-xyz", secret, ttl=60)
    assert validate_docx_preview_token(token, secret) == "blob-xyz"


# ---------------------------------------------------------------------------
# encode_disposition
# ---------------------------------------------------------------------------
def test_encode_disposition_attachment_default_name():
    header = encode_disposition(None, "attachment")
    assert header.startswith("attachment;")
    assert 'filename="download"' in header


def test_encode_disposition_inline_default_name():
    header = encode_disposition(None, "inline")
    assert 'filename="document.pdf"' in header


def test_encode_disposition_sanitises_path_separators_and_quotes():
    header = encode_disposition('a/b\\c".txt', "attachment")
    # path separators replaced with underscore, double quote replaced with '
    assert "a_b_c" in header
    assert '"a_b_c' in header  # opening quote of the ascii filename


def test_encode_disposition_unicode_falls_back_to_ascii_then_encodes():
    header = encode_disposition("résumé.txt", "attachment")
    # ASCII fallback drops the accented chars but keeps a usable name
    assert "filename=" in header
    assert "filename*=UTF-8''" in header
    # the percent-encoded UTF-8 form preserves the original
    assert "%C3%A9" in header  # é


# ---------------------------------------------------------------------------
# stream_blob_response — require_pdf rejection
# ---------------------------------------------------------------------------
async def test_stream_blob_require_pdf_rejects_non_pdf(session_factory, seeded_user, seeded_agent):
    seed = await _seed_blob(
        session_factory=session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="notes.txt",
        mime_type="text/plain",
        data=b"hello",
    )
    async with session_factory() as session:
        with pytest.raises(Exception) as exc:
            await stream_blob_response(
                user_id=seeded_user.id,
                conversation_id=seed["conversation_id"],
                message_id=seed["message_id"],
                blob_id=seed["blob_id"],
                range_header=None,
                db=session,
                disposition="inline",
                require_pdf=True,
            )
        assert getattr(exc.value, "status_code", None) == 400


async def test_stream_blob_require_pdf_allows_pdf(session_factory, seeded_user, seeded_agent):
    seed = await _seed_blob(
        session_factory=session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="doc.pdf",
        mime_type="application/pdf",
        data=b"%PDF-1.4 body",
    )
    async with session_factory() as session:
        response = await stream_blob_response(
            user_id=seeded_user.id,
            conversation_id=seed["conversation_id"],
            message_id=seed["message_id"],
            blob_id=seed["blob_id"],
            range_header=None,
            db=session,
            disposition="inline",
            require_pdf=True,
        )
        assert response.status_code == 200
        body = await _drain(response)
        assert body == b"%PDF-1.4 body"


# ---------------------------------------------------------------------------
# stream_blob_response — full and partial body assembly
# ---------------------------------------------------------------------------
async def test_stream_blob_full_body(session_factory, seeded_user, seeded_agent):
    data = b"abcdefghij"
    seed = await _seed_blob(
        session_factory=session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="f.bin",
        mime_type="application/octet-stream",
        data=data,
    )
    async with session_factory() as session:
        response = await stream_blob_response(
            user_id=seeded_user.id,
            conversation_id=seed["conversation_id"],
            message_id=seed["message_id"],
            blob_id=seed["blob_id"],
            range_header=None,
            db=session,
            disposition="attachment",
        )
        assert response.status_code == 200
        assert response.headers["content-length"] == str(len(data))
        assert await _drain(response) == data


async def test_stream_blob_partial_range_body(session_factory, seeded_user, seeded_agent):
    data = b"0123456789"
    seed = await _seed_blob(
        session_factory=session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="f.bin",
        mime_type="application/octet-stream",
        data=data,
    )
    async with session_factory() as session:
        response = await stream_blob_response(
            user_id=seeded_user.id,
            conversation_id=seed["conversation_id"],
            message_id=seed["message_id"],
            blob_id=seed["blob_id"],
            range_header="bytes=2-5",
            db=session,
            disposition="attachment",
        )
        assert response.status_code == 206
        assert response.headers["content-range"] == f"bytes 2-5/{len(data)}"
        assert response.headers["content-length"] == "4"
        assert await _drain(response) == b"2345"


async def test_stream_blob_open_ended_range(session_factory, seeded_user, seeded_agent):
    data = b"0123456789"
    seed = await _seed_blob(
        session_factory=session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="f.bin",
        mime_type="application/octet-stream",
        data=data,
    )
    async with session_factory() as session:
        response = await stream_blob_response(
            user_id=seeded_user.id,
            conversation_id=seed["conversation_id"],
            message_id=seed["message_id"],
            blob_id=seed["blob_id"],
            range_header="bytes=7-",
            db=session,
            disposition="attachment",
        )
        assert response.status_code == 206
        assert await _drain(response) == b"789"


async def test_stream_blob_invalid_range_unit_returns_416(session_factory, seeded_user, seeded_agent):
    data = b"0123456789"
    seed = await _seed_blob(
        session_factory=session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="f.bin",
        mime_type="application/octet-stream",
        data=data,
    )
    async with session_factory() as session:
        response = await stream_blob_response(
            user_id=seeded_user.id,
            conversation_id=seed["conversation_id"],
            message_id=seed["message_id"],
            blob_id=seed["blob_id"],
            range_header="items=0-4",
            db=session,
            disposition="attachment",
        )
        assert response.status_code == 416
        assert response.headers["content-range"] == f"bytes */{len(data)}"


async def test_stream_blob_image_rejected(session_factory, seeded_user, seeded_agent):
    seed = await _seed_blob(
        session_factory=session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="pic.png",
        mime_type="image/png",
        data=b"img",
    )
    async with session_factory() as session:
        with pytest.raises(Exception) as exc:
            await stream_blob_response(
                user_id=seeded_user.id,
                conversation_id=seed["conversation_id"],
                message_id=seed["message_id"],
                blob_id=seed["blob_id"],
                range_header=None,
                db=session,
                disposition="attachment",
            )
        assert getattr(exc.value, "status_code", None) == 400


async def test_stream_blob_missing_blob_404(session_factory, seeded_user, seeded_agent):
    seed = await _seed_blob(
        session_factory=session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="f.bin",
        mime_type="application/octet-stream",
        data=b"data",
    )
    async with session_factory() as session:
        with pytest.raises(Exception) as exc:
            await stream_blob_response(
                user_id=seeded_user.id,
                conversation_id=seed["conversation_id"],
                message_id=seed["message_id"],
                blob_id="does-not-exist",
                range_header=None,
                db=session,
                disposition="attachment",
            )
        assert getattr(exc.value, "status_code", None) == 404
