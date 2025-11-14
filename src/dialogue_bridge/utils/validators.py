from typing import Any, Dict

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
from vault_auth.auth import require_token_claims


async def validate_userId(
    user_id: str,
    token_claims: Dict[str, Any] = Depends(require_token_claims),
    db: AsyncSession = Depends(get_db),
) -> UserTable:
    """Ensure the caller's JWT authorizes access to the requested user."""
    # Fetch the user row up front; fail fast if the id is unknown.
    result = await db.execute(select(UserTable).filter_by(id=user_id))
    user: UserTable | None = result.scalar_one_or_none()

    if not user:
        raise HTTPException(401, "Invalid or unknown user")

    # Collect all identifiers present on the token so we can compare membership.
    identifiers: set[str] = set()
    candidate_values = [
        token_claims.get("sub"),
        token_claims.get("entity_id"),
        token_claims.get("user_id"),
        token_claims.get("id"),
    ]
    metadata = token_claims.get("metadata")
    if isinstance(metadata, dict):
        candidate_values.extend(metadata.get(key) for key in ("vault_user_id", "user_id", "id"))

    for value in candidate_values:
        if value is None:
            continue
        identifiers.add(str(value))

    if not identifiers:
        # Without any subject hints there is no way to authorize the user id.
        raise HTTPException(
            status_code=403,
            detail="Token missing subject identifiers.",
        )

    if str(user.vault_user_id) not in identifiers and str(user.id) not in identifiers:
        # Token does not reference this user anywhere; reject the request.
        raise HTTPException(
            status_code=403,
            detail="Token does not grant access to this user.",
        )
    return user


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
