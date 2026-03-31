from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import (
    AttachmentTable,
    ConversationTable,
    MessageTable,
    UserTable,
    get_db,
)
from vault_auth.session_auth import require_bound_user_id


async def validate_userId(
    user_id: str,
    current_user: UserTable = Depends(require_bound_user_id),
) -> UserTable:
    """Ensure the caller's authenticated session authorizes access to the requested user."""
    return current_user


async def validate_convId(
    user_id: str,
    conversation_id: str,
    db: AsyncSession = Depends(get_db),
) -> ConversationTable:
    # Scope the lookup by both conversation and user to enforce ownership.
    q = (
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
        .where(
            ConversationTable.id == conversation_id,
            ConversationTable.user_id == user_id,
        )
    )
    res = await db.execute(q)
    conv: ConversationTable | None = res.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conv


async def validate_convId_full(
    user_id: str,
    conversation_id: str,
    db: AsyncSession = Depends(get_db),
) -> ConversationTable:
    # Reuse the ownership filter but eagerly load messages + attachments for downstream use.
    q = (
        select(ConversationTable)
        .options(
            selectinload(ConversationTable.agent),
            selectinload(ConversationTable.messages)
            .selectinload(MessageTable.attachments)
            .selectinload(AttachmentTable.blob),
        )
        .where(
            ConversationTable.id == conversation_id,
            ConversationTable.user_id == user_id,
        )
    )
    res = await db.execute(q)
    conv: ConversationTable | None = res.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conv
