from typing import List, Optional
from uuid import uuid4
from fastapi import FastAPI, Depends, HTTPException, status, Response
from contextlib import asynccontextmanager

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from database import Base, engine, get_db, ConversationTable, UserTable
from schemas import (
    ChatMessage, Conversation, ConversationSummary,
    UserCreate, UserOut, AuthRequest, AuthResponse
)

AGENT_MAPPING = {
    "OrthodoxAI_v1": "http://orthodox_agents:8081/OrthodoxAI/v1/stream",
}

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


app = FastAPI(title="Bridge Service", lifespan=lifespan)

#-----------------------------------------------------------------------------------
# USER APIS
#-----------------------------------------------------------------------------------
@app.post("/authenticate", response_model=AuthResponse)
async def authenticate(creds: AuthRequest, db: AsyncSession = Depends(get_db)):
    """
    Simple credential check. Returns True + user_id on success, False otherwise.
    """
    res = await db.execute(
        select(UserTable).filter_by(
            username=creds.username,
            password=creds.password
        )
    )
    user = res.scalar_one_or_none()
    if user:
        return {"authenticated": True, "user_id": user.id}
    return {"authenticated": False}


@app.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(user: UserCreate, db: AsyncSession = Depends(get_db)):
    """
    Create a new user. Fails with 400 if username already exists.
    """
    # username uniqueness check
    res = await db.execute(select(UserTable).filter_by(username=user.username))
    if res.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already taken")

    user_id = str(uuid4())
    db_user = UserTable(id=user_id, username=user.username, password=user.password)
    db.add(db_user)
    await db.commit()
    return {"user_id": user_id, "username": user.username}


@app.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(user_id: str, db: AsyncSession = Depends(get_db)):
    """
    Delete a user and all their conversations (cascades via FK relationship).
    """
    # 1. Does the user exist?
    res = await db.execute(select(UserTable).filter_by(id=user_id))
    user = res.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # 2. Delete; the cascade rule wipes conversations too
    await db.delete(user)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


#-----------------------------------------------------------------------------------
# CONVERSATIONS APIS
#-----------------------------------------------------------------------------------
@app.post(
    "/users/{user_id}/conversations/{conversation_id}/messages",
    response_model=Conversation,
    status_code=status.HTTP_201_CREATED,
)
async def append_message(
    user_id: str,
    conversation_id: str,
    message: ChatMessage,
    title: Optional[str] = None, 
    db: AsyncSession = Depends(get_db),
):
    """Append a message; create conversation if it doesn’t exist."""
    result = await db.execute(
        select(ConversationTable).filter_by(
            user_id=user_id, conversation_id=conversation_id
        )
    )
    convo: ConversationTable | None = result.scalar_one_or_none()

    new_msg = message.model_dump()

    if convo is None:
        convo = ConversationTable(
            user_id=user_id,
            conversation_id=conversation_id,
            title=title,
            messages=[new_msg]
        )
        db.add(convo)
    else:
        convo.messages = convo.messages + [new_msg]
        if title is not None:
            convo.title = title

    await db.commit()
    await db.refresh(convo)
    return convo


@app.get(
    "/users/{user_id}/conversations",
    response_model=List[ConversationSummary],
    status_code=status.HTTP_200_OK
)
async def list_conversations(user_id: str, db: AsyncSession = Depends(get_db)):
    """Return every conversation (and its messages) for a user."""
    result = await db.execute(select(ConversationTable).filter_by(user_id=user_id))
    return result.scalars().all()


@app.get(
    "/users/{user_id}/conversations/{conversation_id}",
    response_model=Conversation,
    status_code=status.HTTP_200_OK
)
async def get_conversation(user_id: str, conversation_id: str, db: AsyncSession = Depends(get_db)):
    """Fetch one conversation by ID pair."""
    result = await db.execute(
        select(ConversationTable).filter_by(
            user_id=user_id, conversation_id=conversation_id
        )
    )
    convo = result.scalar_one_or_none()
    if convo is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return convo


@app.delete(
    "/users/{user_id}/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT
)
async def delete_conversation(user_id: str, conversation_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a conversation entirely."""
    result = await db.execute(
        delete(ConversationTable).where(
            ConversationTable.user_id == user_id,
            ConversationTable.conversation_id == conversation_id,
        )
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return



