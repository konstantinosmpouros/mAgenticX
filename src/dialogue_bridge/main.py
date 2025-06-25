from typing import List
from uuid import uuid4
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
from database import Base, engine, get_db, seed_users, ConversationTable, UserTable
from schemas import (
    Conversation, ConversationSummary,
    UserCreate, UserOut, AuthRequest, AuthResponse
)
from utils import authenticate_id, upsert_conversation, agent_stream

# Map agent names to their streaming URLs
AGENT_MAPPING = {
    "OrthodoxAI v1": "http://agents:8003/OrthodoxAI/v1/stream",
    "HR-Policies v1": "http://agents:8003/HRPolicies/v1/stream",
    "Retail Agent v1": "http://agents:8003/Retail/v1/stream",
}

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Make sure schema exists
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    # 2. Seed users – only happens if they’re missing
    async with AsyncSession(engine) as session:
        await seed_users(session)
    
    yield

app = FastAPI(title="Bridge Service", lifespan=lifespan)



#-----------------------------------------------------------------------------------
# USER APIS
#-----------------------------------------------------------------------------------
@app.post("/authenticate", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def authenticate_login(creds: AuthRequest, db: AsyncSession = Depends(get_db)):
    """
    Simple credential check. Returns True + user_id on success, False otherwise.
    """
    try:
        res = await db.execute(
            select(UserTable).filter_by(
                username=creds.username,
                password=creds.password
            )
        )
        user = res.scalar_one_or_none()
        await db.close()
        if user:
            return {"authenticated": True, "user_id": user.id}
        return {"authenticated": False}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await db.close()



#-----------------------------------------------------------------------------------
# CONVERSATION APIS
#-----------------------------------------------------------------------------------
@app.get(
    "/users/{user_id}/conversations",
    response_model=List[ConversationSummary],
    status_code=status.HTTP_200_OK
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
    await db.close()
    summaries = [ConversationSummary.model_validate(r, from_attributes=True) for r in rows]
    return summaries


@app.get(
    "/users/{user_id}/conversations/{conversation_id}",
    response_model=Conversation,
    status_code=status.HTTP_200_OK
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
    await db.close()
    if convo is None:
        raise HTTPException(404, "Conversation not found")
    return convo


@app.delete(
    "/users/{user_id}/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT
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
    await db.close()
    if result.rowcount == 0:
        raise HTTPException(404, "Conversation not found")
    return



#-----------------------------------------------------------------------------------
# INFERENCE API
#-----------------------------------------------------------------------------------
@app.post(
    "/user/{user_id}/inference",
    status_code=status.HTTP_200_OK
)
async def inference(
    payload: Conversation,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    # Validate agent name & URL
    if not payload.agents or len(payload.agents) != 1:
        raise HTTPException(400, "No agent was specified or more than one was given")
    
    agent_name = payload.agents[0]
    agent_url = AGENT_MAPPING.get(agent_name)
    if agent_url is None:
        raise HTTPException(400, f"Unknown agent: {agent_name}")
    
    # Persist conversation (create or update)
    _ = await upsert_conversation(payload, db)
    
    # Return a streaming response
    return StreamingResponse(
        agent_stream(agent_url, payload, db),
        media_type="text/event-stream",
        status_code=200,
    )


