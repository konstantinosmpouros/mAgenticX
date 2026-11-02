from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.logging import set_context
from core.database import (
    AttachmentTable,
    ConversationTable,
    MessageTable,
    get_db,
)
from core.auth.session import AuthUser, require_bound_user_id, require_bound_user_id_even_if_pending


async def validate_userId(
    user_id: str,
    current_user: AuthUser = Depends(require_bound_user_id),
) -> AuthUser:
    """Ensure the caller's authenticated session authorizes access to the requested user."""
    set_context(user_id=user_id)
    return current_user


async def validate_userId_even_if_pending(
    user_id: str,
    current_user: AuthUser = Depends(require_bound_user_id_even_if_pending),
) -> AuthUser:
    """:func:`validate_userId` for the routes a user awaiting deletion may still use:
    the deletion's status and cancel, and downloading their data (plan 32)."""
    set_context(user_id=user_id)
    return current_user


async def validate_convId(
    user_id: str,
    conversation_id: str,
    db: AsyncSession = Depends(get_db),
) -> ConversationTable:
    # Scope the lookup by both conversation and user to enforce ownership.
    set_context(user_id=user_id, conversation_id=conversation_id)
    # A "Try it" trial (plan 40) is reachable through the trial routes only:
    # to every conversation route it does not exist, so it cannot be renamed,
    # shared, forked, exported or continued as an ordinary chat.
    q = (
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
        .where(
            ConversationTable.id == conversation_id,
            ConversationTable.user_id == user_id,
            ConversationTable.is_trial.is_(False),
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
    # Trials are excluded, as in validate_convId.
    return await load_conversation_full(db, user_id, conversation_id, trial=False)


async def load_conversation_full(
    db: AsyncSession,
    user_id: str,
    conversation_id: str,
    *,
    trial: bool | None,
) -> ConversationTable:
    """The caller's conversation with its agent, messages and attachments; 404 otherwise.

    ``trial`` picks which kind may match: ``False`` an ordinary conversation
    (every conversation route), ``True`` a "Try it" trial only (the trial
    routes), ``None`` either (the detached run, which serves both). Not a
    route dependency on purpose — a dependency's keyword would become a query
    parameter the client could set.
    """
    set_context(user_id=user_id, conversation_id=conversation_id)
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
    if trial is not None:
        q = q.where(ConversationTable.is_trial.is_(trial))
    res = await db.execute(q)
    conv: ConversationTable | None = res.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conv
