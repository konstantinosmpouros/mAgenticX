from __future__ import annotations

import base64

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable
from router import attachments as attachments_router
from utils.attachments import is_presentation_previewable


async def _seed_attachment(
    *,
    db_session_factory,
    seeded_user,
    seeded_agent,
    file_name: str,
    mime_type: str,
    data: bytes,
):
    async with db_session_factory() as session:
        conversation = ConversationTable(
            user_id=seeded_user.id,
            agent_id=seeded_agent.id,
            agent_name=seeded_agent.name,
            title="Attachment conversation",
            last_message_preview=file_name,
        )
        session.add(conversation)
        await session.flush()

        message = MessageTable(
            conversation_id=conversation.id,
            sender="user",
            type="image" if mime_type.startswith("image/") else "file",
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
            "attachment_id": attachment.id,
            "blob_id": blob.id,
        }


async def test_get_images_batch_returns_base64_payloads(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    image_bytes = b"png-bytes"
    attachment = await _seed_attachment(
        db_session_factory=db_session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="chart.png",
        mime_type="image/png",
        data=image_bytes,
    )

    response = await client.get(f"/v1/attachments/images/{seeded_user.id}?page=1&size=10")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["items"][0]["attachmentId"] == attachment["attachment_id"]
    assert payload["items"][0]["dataB64"] == base64.b64encode(image_bytes).decode("ascii")


async def test_download_blob_stream_supports_full_and_partial_reads(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    blob_bytes = b"hello attachment"
    attachment = await _seed_attachment(
        db_session_factory=db_session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="notes.txt",
        mime_type="text/plain",
        data=blob_bytes,
    )

    full_response = await client.get(
        f"/v1/attachments/download/{seeded_user.id}/{attachment['conversation_id']}/{attachment['message_id']}/{attachment['blob_id']}"
    )
    partial_response = await client.get(
        f"/v1/attachments/download/{seeded_user.id}/{attachment['conversation_id']}/{attachment['message_id']}/{attachment['blob_id']}",
        headers={"Range": "bytes=0-4"},
    )

    assert full_response.status_code == 200
    assert full_response.content == blob_bytes
    assert full_response.headers["content-length"] == str(len(blob_bytes))

    assert partial_response.status_code == 206
    assert partial_response.content == b"hello"
    assert partial_response.headers["content-range"] == f"bytes 0-4/{len(blob_bytes)}"


async def test_download_blob_stream_rejects_invalid_ranges(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    attachment = await _seed_attachment(
        db_session_factory=db_session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="notes.txt",
        mime_type="text/plain",
        data=b"hello attachment",
    )

    response = await client.get(
        f"/v1/attachments/download/{seeded_user.id}/{attachment['conversation_id']}/{attachment['message_id']}/{attachment['blob_id']}",
        headers={"Range": "bytes=99-120"},
    )

    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */16"


async def test_preview_blob_inline_allows_non_image_blobs(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    pdf_attachment = await _seed_attachment(
        db_session_factory=db_session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="brief.pdf",
        mime_type="application/pdf",
        data=b"%PDF test",
    )
    txt_attachment = await _seed_attachment(
        db_session_factory=db_session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="notes.txt",
        mime_type="text/plain",
        data=b"plain text",
    )

    pdf_response = await client.get(
        f"/v1/attachments/preview/{seeded_user.id}/{pdf_attachment['conversation_id']}/{pdf_attachment['message_id']}/{pdf_attachment['blob_id']}"
    )
    txt_response = await client.get(
        f"/v1/attachments/preview/{seeded_user.id}/{txt_attachment['conversation_id']}/{txt_attachment['message_id']}/{txt_attachment['blob_id']}"
    )

    assert pdf_response.status_code == 200
    assert pdf_response.headers["content-type"].startswith("application/pdf")
    assert pdf_response.headers["cache-control"] == "private, max-age=300"
    assert txt_response.status_code == 200
    assert txt_response.content == b"plain text"
    assert txt_response.headers["content-type"].startswith("text/plain")
    assert txt_response.headers["cache-control"] == "private, max-age=300"


async def test_download_blob_stream_rejects_images_and_missing_blobs(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    image_attachment = await _seed_attachment(
        db_session_factory=db_session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="chart.png",
        mime_type="image/png",
        data=b"image bytes",
    )

    image_response = await client.get(
        f"/v1/attachments/download/{seeded_user.id}/{image_attachment['conversation_id']}/{image_attachment['message_id']}/{image_attachment['blob_id']}"
    )
    missing_response = await client.get(
        f"/v1/attachments/download/{seeded_user.id}/{image_attachment['conversation_id']}/{image_attachment['message_id']}/missing-blob"
    )

    assert image_response.status_code == 400
    assert image_response.json()["detail"] == "Images are not served by this endpoint."
    assert missing_response.status_code == 404
    assert missing_response.json()["detail"] == "Blob not found or not accessible."


async def test_preview_blob_derived_converts_powerpoint_to_inline_pdf(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
    monkeypatch,
):
    attachment = await _seed_attachment(
        db_session_factory=db_session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="deck.pptx",
        mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        data=b"pptx bytes",
    )

    async def fake_convert(**_: object) -> tuple[bytes, str]:
        return b"%PDF derived preview", "deck.pdf"

    monkeypatch.setattr(attachments_router, "convert_attachment_to_pdf_preview", fake_convert)

    response = await client.get(
        f"/v1/attachments/preview-derived/{seeded_user.id}/{attachment['conversation_id']}/{attachment['message_id']}/{attachment['blob_id']}"
    )

    assert response.status_code == 200
    assert response.content == b"%PDF derived preview"
    assert response.headers["content-type"].startswith("application/pdf")
    assert response.headers["cache-control"] == "private, max-age=300"
    assert "inline" in response.headers["content-disposition"]
    assert "deck.pdf" in response.headers["content-disposition"]


async def test_preview_blob_derived_rejects_non_presentations(
    client,
    seeded_user,
    seeded_agent,
    db_session_factory,
):
    attachment = await _seed_attachment(
        db_session_factory=db_session_factory,
        seeded_user=seeded_user,
        seeded_agent=seeded_agent,
        file_name="notes.txt",
        mime_type="text/plain",
        data=b"plain text",
    )

    response = await client.get(
        f"/v1/attachments/preview-derived/{seeded_user.id}/{attachment['conversation_id']}/{attachment['message_id']}/{attachment['blob_id']}"
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Only PowerPoint attachments support derived preview."


def test_is_presentation_previewable_matches_supported_powerpoint_formats():
    assert is_presentation_previewable("deck.pptx", "")
    assert is_presentation_previewable("legacy.ppt", "")
    assert is_presentation_previewable("", "application/vnd.ms-powerpoint")
    assert is_presentation_previewable(
        "",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )
    assert not is_presentation_previewable("notes.txt", "text/plain")
