import base64
from copy import deepcopy
from datetime import UTC, datetime, timezone
from typing import List, Optional

from fastapi import HTTPException, status
from sqlalchemy import Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import (
    AgentTable,
    AttachmentTable,
    b64_encode,
    BlobTable,
    ConversationShareTable,
    ConversationTable,
    MessageTable,
    UserTable,
)
from core.settings import settings
from schema import AttachmentIn, MessageIn


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
        # Stamped here, not by the database: Postgres's now() is fixed for the
        # whole transaction, so a user message and the AI reply created with it
        # would tie and come back in whatever order an index scan yields.
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        sender=payload.sender,
        content=payload.content,
        reasoning_steps=payload.thinking,
        reasoning_time_seconds=payload.thinkingTime,
        is_error=bool(payload.error) if payload.error is not None else False,
        error_message=payload.errorMessage,
        raw_events=payload.rawEvents,
        command=payload.command.model_dump() if payload.command else None,
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


async def set_conversation_archive_state(
    db: AsyncSession,
    conv: ConversationTable,
    archived: bool,
) -> None:
    conv.is_archived = archived
    conv.archived_at = datetime.now(timezone.utc).replace(tzinfo=None) if archived else None
    if archived:
        # An archived conversation leaves the sidebar, so it leaves Pinned too —
        # and stops counting against the pin cap. Unarchiving does not restore it.
        conv.is_pinned = False
        conv.pinned_at = None
    await db.commit()
    await db.refresh(
        conv,
        attribute_names=[
            "title",
            "updated_at",
            "last_message_preview",
            "agent",
            "is_archived",
            "archived_at",
            "is_pinned",
            "pinned_at",
        ],
    )


async def set_conversation_pin_state(
    db: AsyncSession,
    conv: ConversationTable,
    pinned: bool,
) -> None:
    """Pin a conversation to the sidebar's Pinned section, or unpin it.

    Idempotent: asking for the state it is already in changes nothing, so a
    repeated pin keeps its place instead of jumping to the top.

    Only conversations that appear in the sidebar can be pinned — private ones
    never do, archived ones have left it — and a user holds at most
    ``settings.conversations.max_pinned`` pins, which is what lets the UI load
    them all in one bounded request.

    The flag is written with a Core UPDATE that sets ``updated_at`` to itself:
    the ORM's ``onupdate=now()`` would otherwise mark the conversation as just
    active, and unpinning would drop it at the top of Chats instead of back in
    its place by recency.
    """
    if conv.is_pinned == pinned:
        return
    if pinned:
        if conv.is_private or conv.is_archived:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Only conversations in your chat history can be pinned.",
            )
        # Serialise this user's pin requests on their users row, so two
        # concurrent pins cannot both pass the cap check below.
        await db.execute(select(UserTable.id).where(UserTable.id == conv.user_id).with_for_update())
        pinned_count = await db.scalar(
            select(func.count())
            .select_from(ConversationTable)
            .where(ConversationTable.user_id == conv.user_id, ConversationTable.is_pinned.is_(True))
        )
        limit = settings.conversations.max_pinned
        if (pinned_count or 0) >= limit:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"You can pin up to {limit} conversations. Unpin one first.",
            )

    await db.execute(
        update(ConversationTable)
        .where(ConversationTable.id == conv.id)
        .values(
            is_pinned=pinned,
            pinned_at=datetime.now(timezone.utc).replace(tzinfo=None) if pinned else None,
            updated_at=ConversationTable.updated_at,
        )
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    await db.refresh(conv, attribute_names=["is_pinned", "pinned_at", "updated_at", "agent"])


async def save_private_conversation(db: AsyncSession, conv: ConversationTable) -> int:
    """Turn a private conversation into a normal one ("Save chat"). One-way.

    The conversation joins the user's chat list at the top (its ``updated_at``
    moves to now, as any activity would), and from then on shows up in search,
    suggestions and the Usage list, which all filter on ``is_private``.

    Its messages go back on the embedding sweeper's queue: while private, the
    sweeper looked at them and marked them checked without a vector (privacy
    was final then). Clearing ``embedding_checked_at`` lets the next passes
    embed them like any other conversation's, so memory search finds them.
    Their own ``updated_at`` is left as it was — this is bookkeeping, not an edit.

    Returns the number of messages queued. 409 if the conversation is not private.
    """
    if not conv.is_private:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation is already saved.",
        )
    now = datetime.now(UTC).replace(tzinfo=None)
    await db.execute(
        update(ConversationTable)
        .where(ConversationTable.id == conv.id, ConversationTable.is_private.is_(True))
        .values(is_private=False, updated_at=now)
        .execution_options(synchronize_session=False)
    )
    queued = await db.execute(
        update(MessageTable)
        .where(MessageTable.conversation_id == conv.id)
        .values(embedding_checked_at=None, updated_at=MessageTable.updated_at)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    await db.refresh(conv, attribute_names=["is_private", "updated_at", "agent"])
    return queued.rowcount or 0


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
        is_pinned=False,
        is_reported=False,
        archived_at=None,
        pinned_at=None,
        reported_at=None,
        last_message_preview=_preview(target_message.content) or fallback_attachment_name,
        last_message_at=now,
        updated_at=now,
    )
    db.add(forked_conv)
    await db.flush()

    message_id_map: dict[str, str] = {}
    for source_message in branch:
        # NOTE: deliberately does NOT copy checkpoint_thread_id / checkpoint_id.
        # The fork is a brand-new conversation with its own durable checkpoint
        # thread — carrying the source's thread ids would make the fork resume
        # or fork against another conversation's (and potentially another
        # user's) live checkpoint. Leaving them NULL makes the fork's first run
        # cold-seed a fresh, isolated thread (full-history reconstruction).
        cloned_message = MessageTable(
            conversation_id=forked_conv.id,
            parent_message_id=message_id_map.get(source_message.parent_message_id),
            sender=source_message.sender,
            content=source_message.content,
            liked=source_message.liked,
            agent_id=source_message.agent_id,
            agent_name=source_message.agent_name,
            reasoning_steps=deepcopy(source_message.reasoning_steps),
            reasoning_time_seconds=source_message.reasoning_time_seconds,
            is_error=source_message.is_error,
            error_message=source_message.error_message,
            raw_events=deepcopy(source_message.raw_events),
            command=deepcopy(source_message.command),
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
                # Carried over, or a generated file would turn into an
                # "upload" in the copy and lose its card.
                origin=source_attachment.origin,
                title=source_attachment.title,
                summary=source_attachment.summary,
                content_sha256=source_attachment.content_sha256,
                presented=source_attachment.presented,
                blob=cloned_blob,
                created_at=source_attachment.created_at,
                updated_at=source_attachment.updated_at,
            )
            db.add(cloned_attachment)

    return forked_conv


def build_share_snapshot(source_conv: ConversationTable, branch: list[MessageTable]) -> dict:
    return {
        "title": source_conv.title,
        "shareMode": "branch",
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
        "liked": message.liked,
        "created_at": message.created_at.isoformat() if message.created_at else None,
        "updated_at": message.updated_at.isoformat() if message.updated_at else None,
        "attachments": [
            _attachment_to_share_snapshot(attachment) for attachment in message.attachments if is_shareable(attachment)
        ],
        "thinking": deepcopy(message.reasoning_steps),
        "thinkingTime": message.reasoning_time_seconds,
        "error": message.is_error,
        "errorMessage": message.error_message,
        "rawEvents": deepcopy(message.raw_events) or [],
        # Just the name — the chip on a shared user message (plan 35).
        "command": deepcopy(message.command),
    }


def is_shareable(attachment: AttachmentTable) -> bool:
    """Whether a file may leave the owner's account (share links, PDF export).

    Uploads and the files the agent presented, yes. A file the agent only wrote
    — stored so the owner never loses it — is the owner's alone.
    """
    return attachment.origin != "generated" or bool(attachment.presented)


def _attachment_to_share_snapshot(attachment: AttachmentTable) -> dict:
    blob_data = attachment.blob.data if attachment.blob is not None else None
    return {
        "id": attachment.id,
        "name": attachment.file_name,
        "mime": attachment.mime_type,
        # So an imported share keeps an artifact an artifact (its card).
        "origin": attachment.origin,
        "title": attachment.title,
        "summary": attachment.summary,
        "size": attachment.size_bytes,
        "timestamp": attachment.created_at.isoformat() if attachment.created_at else None,
        "data": b64_encode(blob_data) if blob_data else None,
    }


def conversation_summaries_query(user_id: str, *, archived: bool = False, pinned: bool = False) -> Select:
    """Build the paginated summary query behind one of the user's conversation lists.

    The sidebar shows two disjoint lists — Pinned (``pinned=True``, newest pin
    first) and Chats (the rest, most recent first) — so a pinned conversation
    never appears twice. ``archived=True`` is the archive, where nothing is
    pinned (archiving clears the pin) and ``pinned`` is ignored.
    """
    stmt = (
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
        .where(
            ConversationTable.user_id == user_id,
            ConversationTable.is_private == False,
            ConversationTable.is_archived == archived,
        )
    )
    if archived:
        return stmt.order_by(
            ConversationTable.archived_at.desc(), ConversationTable.updated_at.desc()
        )
    stmt = stmt.where(ConversationTable.is_pinned == pinned)
    if pinned:
        return stmt.order_by(ConversationTable.pinned_at.desc(), ConversationTable.updated_at.desc())
    return stmt.order_by(ConversationTable.updated_at.desc())


async def get_conversation_with_agent(db: AsyncSession, conversation_id: str) -> ConversationTable:
    """Reload a conversation with its agent eagerly loaded (e.g. after a fork)."""
    result = await db.execute(
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
        .where(ConversationTable.id == conversation_id)
    )
    return result.scalar_one()


async def get_share_for_owner(
    db: AsyncSession, share_id: str, conversation_id: str, owner_user_id: str
) -> ConversationShareTable | None:
    """Load a share link scoped to its owning user and conversation."""
    result = await db.execute(
        select(ConversationShareTable).where(
            ConversationShareTable.id == share_id,
            ConversationShareTable.conversation_id == conversation_id,
            ConversationShareTable.owner_user_id == owner_user_id,
        )
    )
    return result.scalar_one_or_none()


async def list_owned_shares(
    db: AsyncSession, owner_user_id: str, page: int, size: int
) -> List[ConversationShareTable]:
    """Return a page of share links owned by the user, newest first."""
    result = await db.execute(
        select(ConversationShareTable)
        .where(ConversationShareTable.owner_user_id == owner_user_id)
        .order_by(ConversationShareTable.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    return list(result.scalars().all())
