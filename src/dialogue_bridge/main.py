from datetime import datetime

from typing import List
from fastapi import FastAPI, Depends, HTTPException, status
from contextlib import asynccontextmanager

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import (
    Base, engine, get_db,
    seed_users, seed_agents,
    hash_password,
    UserTable,
    AgentTable,
    ConversationTable,
    MessageTable,
)
from schemas import (
    ConversationDetail, ConversationSummary,
    ConversationCreate,
    MessageCreate, MessageOut,
    AuthRequest, AuthResponse,
    AgentFull, AgentPublic,
)
from utils import (
    authenticate_id,
    # upsert_conversation,
    # agent_stream,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Make sure schema exists
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    # 2. Seed users – only happens if they’re missing
    async with AsyncSession(engine) as session:
        await seed_users(session)
        await seed_agents(session)
    
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
                password=hash_password(creds.password)
            )
        )
        user = res.scalar_one_or_none()
        if user:
            return AuthResponse(authenticated=True, user_id=user.id)
        return AuthResponse()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



#-----------------------------------------------------------------------------------
# AGENTS APIS
#-----------------------------------------------------------------------------------
@app.get("/agents", response_model=List[AgentPublic], status_code=status.HTTP_200_OK)
async def getAvailableAgents(db: AsyncSession = Depends(get_db)):
    """
    Fetch active agents from the database.
    """
    result = await db.execute(
        select(AgentTable).where(AgentTable.is_active == True)
    )
    agents = result.scalars().all()
    return [AgentPublic.model_validate(a) for a in agents]



#-----------------------------------------------------------------------------------
# CONVERSATION APIS
#-----------------------------------------------------------------------------------
@app.post(
    "/users/{user_id}/conversations",
    response_model=ConversationDetail,
    status_code=status.HTTP_201_CREATED,
)
async def createConversation(
    user_id: str,
    payload: ConversationCreate,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db),
):
    # Validate agent exists
    agent_query = await db.execute(
        select(AgentTable).where(AgentTable.id == payload.agentId, AgentTable.is_active == True)
    )
    agent = agent_query.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    
    conv = ConversationTable(
        user_id=user_id,
        agent_id=payload.agentId,      # alias from agentId
        agent_name=payload.agentName,  # alias from agentName
        title=payload.title,
        is_private=payload.isPrivate,
    )
    db.add(conv)
    await db.flush() 
    
    # Optional initial message
    if payload.initialMessage:
        m = payload.initialMessage
        msg = MessageTable(
            conversation_id=conv.id,
            sender=m.sender,
            type=m.type,
            content=m.content,
        )
        db.add(msg)
        # update conversation summary fields
        preview = (m.content or "").strip()
        conv.last_message_preview = preview[:200] if preview else None
        # use python time so updated model reflects right away
        now = datetime.now()
        conv.last_message_at = now
        conv.updated_at = now
    
    await db.commit()
    
    # Reload with messages & attachments
    result = await db.execute(
        select(ConversationTable)
        .options(
            selectinload(ConversationTable.messages)
            .selectinload(MessageTable.attachments)
        )
        .where(ConversationTable.user_id == user_id, ConversationTable.id == conv.id)
    )
    conv_loaded = result.scalar_one()
    
    conv_out = ConversationDetail.model_validate(conv_loaded)
    # inject attachment URLs
    # for msg in conv_out.messages:
    #     for att in msg.attachments:
    #         if att.url is None:
    #             att.url = f"{ATTACHMENTS_BASE_URL}/{att.id}"
    return conv_out


@app.post(
    "/users/{user_id}/conversations/{conversation_id}",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def addMessage(
    user_id: str,
    conversation_id: str,
    payload: MessageCreate,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db),
):
    if current_user.id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Forbidden")

    # Validate conversation belongs to user
    conv_q = await db.execute(
        select(ConversationTable).where(
            ConversationTable.user_id == user_id,
            ConversationTable.id == conversation_id,
        )
    )
    conv = conv_q.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    
    msg = MessageTable(
        conversation_id=conversation_id,
        sender=payload.sender,
        type=payload.type,
        content=payload.content,
    )
    db.add(msg)
    
    # update conversation summary
    preview = (payload.content or "").strip()
    now = datetime.now()
    conv.last_message_preview = preview[:200] if preview else conv.last_message_preview
    conv.last_message_at = now
    conv.updated_at = now
    
    await db.commit()
    
    result = await db.execute(
        select(MessageTable)
        .options(selectinload(MessageTable.attachments))
        .where(MessageTable.id == msg.id)
    )
    msg_loaded = result.scalar_one()
    
    # Build response (no attachments in this simple insert)
    return MessageOut.model_validate(msg_loaded)


@app.get(
    "/users/{user_id}/conversations",
    response_model=List[ConversationSummary],
    status_code=status.HTTP_200_OK
)
async def getAllConversations(
    user_id: str,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    """
    Return a conversation summary list for the user
    """
    # fetch all full rows
    result = await db.execute(
        select(ConversationTable)
        .where(ConversationTable.user_id == user_id)
        .order_by(ConversationTable.updated_at.desc())
    )
    rows = result.scalars().all()
    summaries = [ConversationSummary.model_validate(r) for r in rows]
    return summaries


@app.get(
    "/users/{user_id}/conversations/{conversation_id}",
    response_model=ConversationDetail,
    status_code=status.HTTP_200_OK
)
async def getConversation(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    """Fetch one conversation (messages included) by user + conversation id."""
    result = await db.execute(
        select(ConversationTable)
        .options(
            selectinload(ConversationTable.messages)
            .selectinload(MessageTable.attachments)
        )
        .where(
            ConversationTable.user_id == user_id,
            ConversationTable.id == conversation_id,
        )
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(404, "Conversation not found")
    
    conv_out = ConversationDetail.model_validate(conv)
    
    # for msg in conv_out.messages:
    #     for att in msg.attachments:
    #         if att.url is None:
    #             att.url = f"{ATTACHMENTS_BASE_URL}/{att.id}"
    
    return conv_out


@app.delete(
    "/users/{user_id}/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT
)
async def deleteConversation(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(authenticate_id),
    db: AsyncSession = Depends(get_db)
):
    """Delete a conversation entirely (cascades to messages & attachments rows)."""
    result = await db.execute(
        select(ConversationTable).where(
            ConversationTable.user_id == user_id,
            ConversationTable.id == conversation_id,
        )
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    
    await db.delete(conv)
    await db.commit()
    
    return



#-----------------------------------------------------------------------------------
# INFERENCE API
#-----------------------------------------------------------------------------------
# @app.post(
#     "/user/{user_id}/inference",
#     status_code=status.HTTP_200_OK
# )
# async def inference(
#     payload: Conversation,
#     current_user: UserTable = Depends(authenticate_id),
#     db: AsyncSession = Depends(get_db)
# ):
#     # Validate agent name & URL
#     if not payload.agents or len(payload.agents) != 1:
#         raise HTTPException(400, "No agent was specified or more than one was given")
    
#     agent_name = payload.agents[0]
#     agent = _AGENTS.get(agent_name)
#     if agent is None:
#         raise HTTPException(400, f"Unknown agent: {agent_name}")
#     agent_url = agent.url
    
#     # Persist conversation (create or update)
#     _ = await upsert_conversation(payload, db)
    
#     # Return a streaming response
#     return StreamingResponse(
#         agent_stream(agent_url, payload, db),
#         media_type="text/event-stream",
#         status_code=200,
#     )


