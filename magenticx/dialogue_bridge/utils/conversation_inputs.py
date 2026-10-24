"""A conversation's uploads, served to the agents service (plan 43).

The agent's ``/conversation/input/`` folder is a view of these rows — nothing is
copied to the agents service any more. It lists every upload of the
conversation, every turn and every branch, under the stable name assigned at
upload (``attachments.workspace_name``), and reads one when the agent opens it.
Every query is scoped to the conversation *and* its owner, so a wrong id from
the caller finds nothing rather than someone else's file.
"""
from __future__ import annotations

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable


def _owned_uploads(conversation_id: str, user_id: str, *columns) -> Select:
    return (
        select(*columns)
        .select_from(AttachmentTable)
        .join(MessageTable, AttachmentTable.message_id == MessageTable.id)
        .join(ConversationTable, MessageTable.conversation_id == ConversationTable.id)
        .join(BlobTable, AttachmentTable.blob_id == BlobTable.id)
        .where(
            ConversationTable.id == conversation_id,
            ConversationTable.user_id == user_id,
            AttachmentTable.origin == "upload",
            AttachmentTable.workspace_name.is_not(None),
            AttachmentTable.content_sha256.is_not(None),
        )
    )


async def conversation_is_owned(db: AsyncSession, conversation_id: str, user_id: str) -> bool:
    found = await db.scalar(
        select(ConversationTable.id).where(
            ConversationTable.id == conversation_id, ConversationTable.user_id == user_id
        )
    )
    return found is not None


async def list_input_files(db: AsyncSession, conversation_id: str, user_id: str) -> list[dict[str, object]]:
    """One entry per name, oldest upload first — the same bytes sent twice
    share a name, so the list never shows a file twice."""
    rows = await db.execute(
        _owned_uploads(
            conversation_id,
            user_id,
            AttachmentTable.id,
            AttachmentTable.workspace_name,
            AttachmentTable.mime_type,
            AttachmentTable.content_sha256,
            AttachmentTable.created_at,
            func.length(BlobTable.data),
        ).order_by(AttachmentTable.created_at, AttachmentTable.id)
    )
    files: dict[str, dict[str, object]] = {}
    for attachment_id, name, mime, sha256, created_at, size in rows.all():
        files.setdefault(name, {
            "name": name,
            "attachment_id": attachment_id,
            "mime": mime,
            "size": int(size or 0),
            "sha256": sha256,
            "created_at": created_at.isoformat() if created_at else None,
        })
    return sorted(files.values(), key=lambda entry: str(entry["name"]))


async def read_input_file(
    db: AsyncSession, conversation_id: str, user_id: str, attachment_id: str
) -> bytes | None:
    data = await db.scalar(
        _owned_uploads(conversation_id, user_id, BlobTable.data).where(AttachmentTable.id == attachment_id)
    )
    return bytes(data) if data is not None else None


async def existing_conversation_ids(db: AsyncSession, user_id: str, conversation_ids: list[str]) -> list[str]:
    """Which of these conversations the user still has."""
    if not conversation_ids:
        return []
    found = await db.scalars(
        select(ConversationTable.id).where(
            ConversationTable.user_id == user_id, ConversationTable.id.in_(conversation_ids)
        )
    )
    return sorted(found)
