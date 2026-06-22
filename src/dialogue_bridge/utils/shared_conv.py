from copy import deepcopy
from datetime import datetime, timedelta, timezone

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
from schemas import (
    ConversationShareListItem,
    MessageIn,
)
from core.settings import settings
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


def resolve_share_expires_at(expires_at: datetime | None, now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    resolved = expires_at or (now + timedelta(days=settings.share.default_ttl_days))
    resolved = resolved.replace(tzinfo=None)
    max_expires_at = now + timedelta(days=settings.share.max_ttl_days)
    if resolved > max_expires_at:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Share expiration cannot be more than {settings.share.max_ttl_days} days from now.",
        )
    return resolved


def share_status(share: ConversationShareTable, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    if not share.is_active or share.revoked_at is not None:
        return "revoked"
    if share.expires_at is not None and share.expires_at <= now:
        return "expired"
    return "active"


def share_mode(share: ConversationShareTable) -> str:
    snapshot = share.snapshot_json if isinstance(share.snapshot_json, dict) else {}
    mode = snapshot.get("shareMode")
    return mode if mode in {"full", "branch", "message"} else "branch"


def build_share_list_item(share: ConversationShareTable, now: datetime | None = None) -> ConversationShareListItem:
    return ConversationShareListItem(
        id=share.id,
        token=share.token,
        shareUrl=f"/share/{share.token}",
        conversationId=share.conversation_id,
        messageId=share.snapshot_until_message_id,
        shareMode=share_mode(share),
        title=share.title,
        isActive=bool(share.is_active),
        status=share_status(share, now),
        revokedAt=share.revoked_at,
        expiresAt=share.expires_at,
        createdAt=share.created_at,
    )


async def load_active_share(token: str, db: AsyncSession) -> ConversationShareTable:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    result = await db.execute(
        select(ConversationShareTable).where(
            ConversationShareTable.token == token,
            ConversationShareTable.is_active == True,
            ConversationShareTable.revoked_at.is_(None),
            (
                (ConversationShareTable.expires_at.is_(None))
                | (ConversationShareTable.expires_at > now)
            ),
        )
    )
    share = result.scalar_one_or_none()
    if share is None:
        raise share_not_found()
    return share


async def create_conversation_from_share_record(
    *,
    db: AsyncSession,
    share: ConversationShareTable,
    current_user: UserTable,
    first_message: MessageIn,
) -> tuple[ConversationTable, str]:
    snapshot = dict(share.snapshot_json or {})
    if snapshot.get("shareMode") != "full":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only full-conversation shares can be continued.",
        )
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
        last_message_preview=_preview(first_message.content),
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
        # No checkpoint_thread_id / checkpoint_id: a continued share is a new
        # conversation owned by (potentially) a different user. It must NEVER
        # reference the original owner's durable checkpoint thread. NULL here
        # means the first run cold-seeds a fresh, isolated thread.
        imported = MessageTable(
            conversation_id=conv.id,
            parent_message_id=message_id_map.get(item.get("parentMessageId")),
            sender=item.get("sender") or "ai",
            content=item.get("content"),
            liked=item.get("liked"),
            reasoning_steps=deepcopy(item.get("thinking")),
            reasoning_time_seconds=item.get("thinkingTime"),
            is_error=bool(item.get("error")),
            error_message=item.get("errorMessage"),
            raw_events=deepcopy(item.get("rawEvents")) or [],
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

    first_reply = await init_message(db, conv, first_message, parent_message_id=last_imported_message.id if last_imported_message else None)
    conv.last_message_preview = _preview(first_reply.content)
    conv.last_message_at = now
    conv.updated_at = now
    await db.flush()

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
    return conv_full, first_reply.id
