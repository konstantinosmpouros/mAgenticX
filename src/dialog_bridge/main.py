from typing import List, Dict

from fastapi import FastAPI, Depends, HTTPException, status
from contextlib import asynccontextmanager
from pydantic import BaseModel

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from database import Base, engine, get_db
from sqlalchemy import Column, String, JSON


class Conversation(Base):
    __tablename__ = "conversations"

    # Composite primary key: (user_id, conversation_id)
    user_id: str = Column(String, primary_key=True, index=True)
    conversation_id: str = Column(String, primary_key=True, index=True)

    # Entire chat history: List[Dict[str, str]]
    messages: List[Dict[str, str]] = Column(JSON, nullable=False)


# Pydantic schemas
class ChatMessage(BaseModel):
    role: str
    content: str

class ConversationOut(BaseModel):
    user_id: str
    conversation_id: str
    messages: List[ChatMessage]

    class Config:
        orm_mode = True


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


app = FastAPI(title="Bridge Service", lifespan=lifespan)


@app.post(
    "/users/{user_id}/conversations/{conversation_id}/messages",
    response_model=ConversationOut,
    status_code=status.HTTP_201_CREATED,
)
async def append_message(
    user_id: str,
    conversation_id: str,
    message: ChatMessage,
    db: AsyncSession = Depends(get_db),
):
    """Append a message; create conversation if it doesn’t exist."""
    result = await db.execute(
        select(Conversation).filter_by(
            user_id=user_id, conversation_id=conversation_id
        )
    )
    convo: Conversation | None = result.scalar_one_or_none()

    new_msg = message.dict()

    if convo is None:
        convo = Conversation(
            user_id=user_id, conversation_id=conversation_id, messages=[new_msg]
        )
        db.add(convo)
    else:
        convo.messages = convo.messages + [new_msg]

    await db.commit()
    await db.refresh(convo)
    return convo


@app.get("/users/{user_id}/conversations", response_model=List[ConversationOut])
async def list_conversations(
    user_id: str,
    db: AsyncSession = Depends(get_db)
) -> List[ConversationOut]:
    """Return every conversation (and its messages) for a user."""
    result = await db.execute(select(Conversation).filter_by(user_id=user_id))
    return result.scalars().all()


@app.get("/users/{user_id}/conversations/{conversation_id}", response_model=ConversationOut)
async def get_conversation(
    user_id: str,
    conversation_id: str,
    db: AsyncSession = Depends(get_db)
):
    """Fetch one conversation by ID pair."""
    result = await db.execute(
        select(Conversation).filter_by(
            user_id=user_id, conversation_id=conversation_id
        )
    )
    convo = result.scalar_one_or_none()
    if convo is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return convo


@app.delete("/users/{user_id}/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    user_id: str,
    conversation_id: str,
    db: AsyncSession = Depends(get_db)
):
    """Delete a conversation entirely."""
    result = await db.execute(
        delete(Conversation).where(
            Conversation.user_id == user_id,
            Conversation.conversation_id == conversation_id,
        )
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return



