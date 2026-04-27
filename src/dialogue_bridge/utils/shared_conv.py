from copy import deepcopy
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import (
    AgentTable,
    AttachmentTable,
    BlobTable,
    ConversationShareTable,
    ConversationTable,
    MessageTable,
    UserTable,
    b64_decode,
)
from schemas import ContinueSharedConversationIn, ConversationDetail, ConversationSummary, CreateConversationResponse
from utils.conversations import _preview, init_message


def parse_snapshot_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def share_not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shared conversation not found.")


async def load_active_share(token: str, db: AsyncSession) -> ConversationShareTable:
    result = await db.execute(
        select(ConversationShareTable).where(
            ConversationShareTable.token == token,
            ConversationShareTable.is_active == True,
            ConversationShareTable.revoked_at.is_(None),
        )
    )
    share = result.scalar_one_or_none()
    if share is None:
        raise share_not_found()
    return share


async def create_conversation_from_share(
    *,
    db: AsyncSession,
    share: ConversationShareTable,
    current_user: UserTable,
    payload: ContinueSharedConversationIn,
) -> CreateConversationResponse:
    snapshot = dict(share.snapshot_json or {})
    snapshot_messages = list(snapshot.get("messages") or [])
    if not snapshot_messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Shared conversation has no messages to continue.")

    agent_data = dict(snapshot.get("agent") or {})
    agent_id = agent_data.get("id")
    agent_result = await db.execute(select(AgentTable).where(AgentTable.id == agent_id, AgentTable.is_active == True))
    agent = agent_result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Shared conversation agent is unavailable.")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    title = snapshot.get("title") or share.title or agent.name or "Shared conversation"
    conv = ConversationTable(
        user_id=current_user.id,
        agent_id=agent.id,
        agent_name=agent.name,
        title=title,
        is_private=False,
        last_message_preview=_preview(payload.firstMessage.content),
        last_message_at=now,
        updated_at=now,
    )
    db.add(conv)
    await db.flush()

    message_id_map: dict[str, str] = {}
    last_imported_message: MessageTable | None = None
    for item in snapshot_messages:
        if not isinstance(item, dict):
            continue
        created_at = parse_snapshot_datetime(item.get("created_at")) or now
        updated_at = parse_snapshot_datetime(item.get("updated_at")) or created_at
        imported = MessageTable(
            conversation_id=conv.id,
            parent_message_id=message_id_map.get(item.get("parentMessageId")),
            sender=item.get("sender") or "ai",
            type=item.get("type") or "text",
            content=item.get("content"),
            liked=item.get("liked"),
            reasoning_steps=deepcopy(item.get("thinking")),
            reasoning_time_seconds=item.get("thinkingTime"),
            is_error=bool(item.get("error")),
            error_message=item.get("errorMessage"),
            raw_events=deepcopy(item.get("rawEvents")) or [],
            plan=deepcopy(item.get("plan")),
            subagents=deepcopy(item.get("subagents")),
            created_at=created_at,
            updated_at=updated_at,
        )
        db.add(imported)
        await db.flush()
        if item.get("id"):
            message_id_map[str(item["id"])] = imported.id
        last_imported_message = imported

        for attachment in item.get("attachments") or []:
            if not isinstance(attachment, dict):
                continue
            blob = BlobTable(data=b64_decode(attachment["data"])) if attachment.get("data") else None
            db.add(AttachmentTable(
                message_id=imported.id,
                file_name=attachment.get("name") or "attachment",
                mime_type=attachment.get("mime") or "application/octet-stream",
                size_bytes=attachment.get("size"),
                blob=blob,
                created_at=parse_snapshot_datetime(attachment.get("timestamp")) or created_at,
                updated_at=parse_snapshot_datetime(attachment.get("timestamp")) or updated_at,
            ))

    first_reply = await init_message(db, conv, payload.firstMessage, parent_message_id=last_imported_message.id if last_imported_message else None)
    conv.last_message_preview = _preview(first_reply.content)
    conv.last_message_at = now
    conv.updated_at = now
    await db.commit()

    result = await db.execute(
        select(ConversationTable)
        .options(
            selectinload(ConversationTable.agent),
            selectinload(ConversationTable.messages)
            .selectinload(MessageTable.attachments)
            .selectinload(AttachmentTable.blob),
        )
        .where(ConversationTable.id == conv.id, ConversationTable.user_id == current_user.id)
    )
    conv_full = result.scalar_one()
    return CreateConversationResponse(
        detail=ConversationDetail.model_validate(conv_full),
        summary=ConversationSummary.model_validate(conv_full),
    )
