from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends, HTTPException

from database import get_db, UserTable, ConversationTable
from schemas import Conversation


async def authenticate_id(user_id: str, db: AsyncSession = Depends(get_db)) -> UserTable:
    """Generic authenticator by user id"""
    result = await db.execute(
        select(UserTable).filter_by(id=user_id)
    )
    user: UserTable | None = result.scalar_one_or_none()

    if not user:
        raise HTTPException(401, "Invalid or unknown user")
    return user

async def upsert_conversation(payload: Conversation, db: AsyncSession) -> ConversationTable:
    """Create or update the ConversationTable row, then return it."""
    try:
        if payload.conversation_id is None:
            payload.conversation_id = uuid.uuid4().hex
        
        result = await db.execute(
            select(ConversationTable).filter_by(
                user_id=payload.user_id,
                conversation_id=payload.conversation_id,
            )
        )
        convo = result.scalar_one_or_none()
        if convo is None:
            convo = ConversationTable(
                user_id=payload.user_id,
                conversation_id=payload.conversation_id,
                title=payload.title,
                messages=payload.messages,
                agents=payload.agents,
            )
            db.add(convo)
        else:
            convo.messages = payload.messages
            convo.agents += payload.agents
            if payload.title and payload.title != convo.title:
                convo.title = payload.title

        await db.commit()
        await db.refresh(convo)
        return convo

    except IntegrityError as e:
        if "conversations_user_id_fkey" in str(e.orig):
            raise HTTPException(400, "Cannot create conversation for non-existent user")
        raise  # re-raise any other DB error