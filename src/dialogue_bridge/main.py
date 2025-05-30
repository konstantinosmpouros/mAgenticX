import json
import httpx
from typing import List
from uuid import uuid4
from fastapi import FastAPI, Depends, HTTPException, status, Response
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from database import Base, engine, get_db, ConversationTable, UserTable
from schemas import (
    Conversation, ConversationSummary,
    UserCreate, UserOut, AuthRequest, AuthResponse
)
from utils import authenticate_id, upsert_conversation

AGENT_MAPPING = {
    "OrthodoxAI_v1": "http://agents:8081/OrthodoxAI/v1/stream",
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
async def authenticate_login(creds: AuthRequest, db: AsyncSession = Depends(get_db)):
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
        raise HTTPException(400, "Username already taken")

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
        raise HTTPException(404, "User not found")

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
    status_code=201
)
async def update_conv(
    payload: Conversation,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    """Append a message or create conversation if it doesn't exist."""
    return await upsert_conversation(payload, db)


@app.get(
    "/users/{user_id}/conversations",
    response_model=List[ConversationSummary],
    status_code=200
)
async def list_conversations(
    user_id: str,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    """
    Return ONLY the (user_id, conversation_id, title) for all
    conversations that belong to this user.
    """
    # fetch all full rows
    rows = (
        await db.execute(
            select(ConversationTable).filter_by(user_id=user_id).order_by(ConversationTable.updated_at.desc())
        )
    ).scalars().all()

    summaries = [ConversationSummary.model_validate(r, from_attributes=True) for r in rows]
    return summaries


@app.get(
    "/users/{user_id}/conversations/{conversation_id}",
    response_model=Conversation,
    status_code=200
)
async def get_conversation(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    """Fetch one conversation by ID pair."""
    result = await db.execute(
        select(ConversationTable).filter_by(
            user_id=user_id, conversation_id=conversation_id
        )
    )
    convo: ConversationTable | None = result.scalar_one_or_none()
    if convo is None:
        raise HTTPException(404, "Conversation not found")
    return convo


@app.delete(
    "/users/{user_id}/conversations/{conversation_id}",
    status_code=204
)
async def delete_conversation(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    """Delete a conversation entirely."""
    result = await db.execute(
        delete(ConversationTable).where(
            ConversationTable.user_id == user_id,
            ConversationTable.conversation_id == conversation_id,
        )
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(404, "Conversation not found")
    return



#-----------------------------------------------------------------------------------
# INFERENCE APIS
#-----------------------------------------------------------------------------------
@app.get(
    "/user/{user_id}/inference",
    status_code=status.HTTP_200_OK
)
async def inference(
    payload: Conversation,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    # Validate agent name & URL
    if not payload.agents:
        raise HTTPException(400, "No agent was specified")

    agent_name = payload.agents[0]
    agent_url = AGENT_MAPPING.get(agent_name)
    if agent_url is None:
        raise HTTPException(400, f"Unknown agent: {agent_name}")

    # Persist conversation (create or update)
    conv = await upsert_conversation(payload, db)
    
    # Create an async generator that forwards the stream
    async def agent_stream():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", agent_url, json={"user_input": conv.messages}) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        # Optionally validate line is JSON:
                        try:
                            json.dumps(line).encode("utf-8")
                        except json.JSONDecodeError:
                            # wrap raw text inside {type:content}
                            line = json.dumps({"type": "raw", "content": line})
                        yield line + "\n"  # newline keeps the UI happy
        except httpx.HTTPError as exc:
            # Bubble up a meaningful error to the UI
            err_msg = json.dumps(
                {"type": "error", "content": f"Agent call failed: {exc}"}
            )
            yield err_msg + "\n"

    # Return a streaming response
    return StreamingResponse(
        agent_stream(),
        media_type="application/x-ndjson",
        status_code=status.HTTP_200_OK,
    )






