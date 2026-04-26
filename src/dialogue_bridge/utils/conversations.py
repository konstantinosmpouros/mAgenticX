import base64
from copy import deepcopy
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    AgentTable,
    AttachmentTable,
    b64_encode,
    BlobTable,
    ConversationTable,
    MessageTable,
    UserTable,
)
from schemas import AttachmentIn, MessageIn


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


def build_message_lineage(messages: list[MessageTable], target_message_id: str) -> list[MessageTable]:
    lookup = {message.id: message for message in messages}
    target = lookup.get(target_message_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Fork target message does not belong to this conversation.",
        )
    if target.sender != "ai":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only AI messages can be used as a fork target.",
        )
    if not target.content and not target.attachments:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot fork from an unfinished AI message.",
        )

    lineage: list[MessageTable] = []
    current: MessageTable | None = target
    seen: set[str] = set()
    while current is not None:
        if current.id in seen:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Conversation branch is cyclic.")
        seen.add(current.id)
        lineage.append(current)

        parent_id = current.parent_message_id
        if not parent_id:
            break
        current = lookup.get(parent_id)
        if current is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Conversation branch is incomplete.")

    lineage.reverse()
    return lineage


async def clone_branch_to_conversation(
    *,
    db: AsyncSession,
    source_conv: ConversationTable,
    branch: list[MessageTable],
    forked_message_id: str,
) -> ConversationTable:
    target_message = branch[-1]
    fallback_attachment_name = target_message.attachments[0].file_name if target_message.attachments else None
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    forked_conv = ConversationTable(
        user_id=source_conv.user_id,
        agent_id=source_conv.agent_id,
        forked_parent_id=source_conv.id,
        forked_message_id=forked_message_id,
        agent_name=source_conv.agent_name,
        title=source_conv.title,
        is_private=source_conv.is_private,
        is_archived=False,
        is_reported=False,
        archived_at=None,
        reported_at=None,
        last_message_preview=_preview(target_message.content) or fallback_attachment_name,
        last_message_at=now,
        updated_at=now,
    )
    db.add(forked_conv)
    await db.flush()

    message_id_map: dict[str, str] = {}
    for source_message in branch:
        cloned_message = MessageTable(
            conversation_id=forked_conv.id,
            parent_message_id=message_id_map.get(source_message.parent_message_id),
            sender=source_message.sender,
            type=source_message.type,
            content=source_message.content,
            liked=source_message.liked,
            reasoning_steps=deepcopy(source_message.reasoning_steps),
            reasoning_time_seconds=source_message.reasoning_time_seconds,
            is_error=source_message.is_error,
            error_message=source_message.error_message,
            raw_events=deepcopy(source_message.raw_events),
            plan=deepcopy(source_message.plan),
            subagents=deepcopy(source_message.subagents),
            created_at=source_message.created_at,
            updated_at=source_message.updated_at,
        )
        db.add(cloned_message)
        await db.flush()
        message_id_map[source_message.id] = cloned_message.id

        for source_attachment in source_message.attachments:
            source_blob = source_attachment.blob
            cloned_blob = BlobTable(data=source_blob.data) if source_blob is not None else None
            cloned_attachment = AttachmentTable(
                message_id=cloned_message.id,
                file_name=source_attachment.file_name,
                mime_type=source_attachment.mime_type,
                size_bytes=source_attachment.size_bytes,
                blob=cloned_blob,
                created_at=source_attachment.created_at,
                updated_at=source_attachment.updated_at,
            )
            db.add(cloned_attachment)

    return forked_conv


def build_share_snapshot(source_conv: ConversationTable, branch: list[MessageTable]) -> dict:
    return {
        "title": source_conv.title,
        "agent": {
            "id": source_conv.agent.id,
            "name": source_conv.agent.name,
            "description": source_conv.agent.description,
            "icon": source_conv.agent.icon,
            "version": source_conv.agent.version,
            "isActive": source_conv.agent.is_active,
        },
        "messages": [_message_to_share_snapshot(message) for message in branch],
    }


def _message_to_share_snapshot(message: MessageTable) -> dict:
    return {
        "id": message.id,
        "parentMessageId": message.parent_message_id,
        "content": message.content,
        "sender": message.sender,
        "type": message.type,
        "liked": message.liked,
        "created_at": message.created_at.isoformat() if message.created_at else None,
        "updated_at": message.updated_at.isoformat() if message.updated_at else None,
        "attachments": [_attachment_to_share_snapshot(attachment) for attachment in message.attachments],
        "thinking": deepcopy(message.reasoning_steps),
        "thinkingTime": message.reasoning_time_seconds,
        "error": message.is_error,
        "errorMessage": message.error_message,
        "rawEvents": deepcopy(message.raw_events) or [],
        "plan": deepcopy(message.plan),
        "subagents": deepcopy(message.subagents),
    }


def _attachment_to_share_snapshot(attachment: AttachmentTable) -> dict:
    blob_data = attachment.blob.data if attachment.blob is not None else None
    return {
        "id": attachment.id,
        "name": attachment.file_name,
        "mime": attachment.mime_type,
        "size": attachment.size_bytes,
        "timestamp": attachment.created_at.isoformat() if attachment.created_at else None,
        "data": b64_encode(blob_data) if blob_data else None,
    }
