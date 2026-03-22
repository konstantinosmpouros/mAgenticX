import base64
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from database import (
    AgentTable,
    AttachmentTable,
    BlobTable,
    ConversationTable,
    MessageTable,
    UserTable,
)
from database.schemas import AttachmentIn, MessageIn


async def init_conv(
    db: AsyncSession,
    user: UserTable,
    agent: AgentTable,
    is_private: bool,
    title: Optional[str],
    first_message: MessageIn,
) -> ConversationTable:
    # Pre-populate the conversation shell so we have ids for downstream inserts.
    conv = ConversationTable(
        user_id=user.id,
        agent_id=agent.id,
        agent_name=agent.name,
        is_private=is_private,
        title=title,
        last_message_preview=_preview(first_message.content)
        or (first_message.attachments[0].name if first_message.attachments else None),
    )
    db.add(conv)
    await db.flush()  # Ensure conv.id exists before creating the first message.

    # Immediately persist the first message within the same transaction.
    await init_message(db, conv, first_message, parent_message_id=None)
    return conv


async def init_message(
    db: AsyncSession,
    conv: ConversationTable,
    payload: MessageIn,
    parent_message_id: str | None = None,
) -> MessageTable:
    # Create the ORM row for the inbound payload, mirroring all metadata.
    msg = MessageTable(
        conversation_id=conv.id,
        parent_message_id=parent_message_id,
        sender=payload.sender,
        type=payload.type,
        content=payload.content,
        reasoning_steps=payload.thinking,
        reasoning_time_seconds=payload.thinkingTime,
        is_error=bool(payload.error) if payload.error is not None else False,
        error_message=payload.errorMessage,
        raw_events=payload.rawEvents,
        plan=payload.plan,
        subagents=payload.subagents,
    )
    db.add(msg)
    await db.flush()  # Assign msg.id for attachment inserts.

    if payload.attachments:
        # Persist attachment rows (and blobs) tied to the new message id.
        await init_attachments(db, msg.id, payload.attachments)

    return msg


async def init_attachments(db: AsyncSession, message_id: str, items: List[AttachmentIn]) -> None:
    for item in items:
        try:
            # Validate user data is real base64 before storing raw bytes.
            raw = base64.b64decode(item.dataB64, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Attachment '{item.name}' is not valid base64.")
        blob = BlobTable(data=raw)
        attach = AttachmentTable(
            message_id=message_id,
            file_name=item.name,
            mime_type=item.mime,
            size_bytes=item.size if item.size is not None else len(raw),
            blob=blob,
        )
        db.add(attach)


def _preview(text: Optional[str]) -> Optional[str]:
    MAX_PREVIEW_LEN = 40
    if not text:
        return None
    # Collapse whitespace/newlines so previews stay compact in the UI.
    s = text.strip().replace("\r", " ").replace("\n", " ")
    return s[:MAX_PREVIEW_LEN]
