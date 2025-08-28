import base64
from typing import List

from fastapi import FastAPI, Depends, HTTPException, status
from contextlib import asynccontextmanager

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import (
    Base, engine, get_db,
    seed_users, seed_agents,
    hash_password,
    UserTable,
    AgentTable,
    ConversationTable,
    MessageTable,
    AttachmentTable,
    BlobTable,
)
from schemas import (
    ConversationDetail, ConversationSummary, CreateConversationResponse,
    ConversationIn,
    BlobDownloadRequest, BlobDownloadResponse,
    AuthRequest, AuthResponse,
    AgentPublic,
)
from utils import (
    validate_userId,
    validate_convId,
    validate_convId_full,
    validate_agentId,
    init_conv,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1) Initialize the database schema if its not
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    # 2) Seed users & agents, then demo data
    async with AsyncSession(engine) as session:
        await seed_users(session)
        await seed_agents(session)
    
    yield

app = FastAPI(title="Bridge Service", lifespan=lifespan)


#-----------------------------------------------------------------------------------
# USER APIS
#-----------------------------------------------------------------------------------
@app.post("/authenticate", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def authenticate(creds: AuthRequest, db: AsyncSession = Depends(get_db)):
    """
    Simple credential check. Returns True + user_id on success, False and None otherwise.
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
# CREATE APIS
#-----------------------------------------------------------------------------------
@app.post(
    "/users/{user_id}/conversations",
    response_model=CreateConversationResponse,
    status_code=status.HTTP_201_CREATED
)
async def create_conversation(
    user_id: str,
    payload: ConversationIn,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db)
) -> ConversationDetail:
    """
    Create a new conversation for the user and persist the very first message
    (with optional attachments). Returns the full conversation detail.
    """
    # Validate agent
    agent = await validate_agentId(db, payload.agentId)
    
    # Create conversation + first message atomically
    try:
        # 2) Do all inserts/flushes
        conv = await init_conv(
            db=db,
            user=current_user,
            agent=agent,
            is_private=payload.isPrivate,
            title=payload.title,
            first_message=payload.firstMessage,
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    
    # Reload with nested attachments->blob so images get base64 injected by AttachmentOut
    conv_full = await validate_convId_full(user_id, conv.id, db)
    
    # Build both DTOs from the same ORM instance
    detail = ConversationDetail.model_validate(conv_full)
    summary = ConversationSummary.model_validate(conv_full)

    return CreateConversationResponse(detail=detail, summary=summary)



#-----------------------------------------------------------------------------------
# READ APIS
#-----------------------------------------------------------------------------------
@app.get(
    "/users/{user_id}/conversations",
    response_model=List[ConversationSummary],
    status_code=status.HTTP_200_OK
)
async def getConvsSummary(
    user_id: str,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db)
):
    """
    Return a conversation summary list for the user
    """
    # fetch all full rows
    result = await db.execute(
        select(ConversationTable)
        .where(
            ConversationTable.user_id == user_id,
            ConversationTable.is_private == False
        )
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
async def getConvDetails(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
):
    """Fetch one conversation (messages included) by user + conversation id."""
    return ConversationDetail.model_validate(current_conv)


@app.post(
    "/users/{user_id}/conversations/{conversation_id}/messages/{message_id}/blobs/download",
    response_model=BlobDownloadResponse,
    status_code=status.HTTP_200_OK
)
async def download_blob(
    user_id: str,
    conversation_id: str,
    message_id: str,
    payload: BlobDownloadRequest,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns ONE thing from BlobTable: 'data' (base64-encoded).
    Validates the blob is attached to the specified message, which belongs to
    the specified conversation, which belongs to the specified user.
    Rejects image/* MIME types.
    """
    if not payload.blobId:
        raise HTTPException(status_code=500, detail="No id was provided")
    
    # Fast join chain across indexed FKs: attachments.message_id, messages.conversation_id, attachments.blob_id
    result = await db.execute(
        select(BlobTable.data, AttachmentTable.mime_type)
        .join(AttachmentTable, AttachmentTable.blob_id == BlobTable.id)
        .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            BlobTable.id == payload.blobId,
            AttachmentTable.message_id == message_id,
            MessageTable.id == message_id,
            MessageTable.conversation_id == conversation_id,
            ConversationTable.id == conversation_id,
            ConversationTable.user_id == user_id,
        )
    )
    row = result.one_or_none()
    
    if not row:
        # Either blob not found or not owned/attached as claimed
        raise HTTPException(status_code=404, detail="Blob not found or not accessible.")
    
    data, mime = row.data, row.mime_type
    
    if mime and mime.startswith("image/"):
        raise HTTPException(status_code=400, detail="Images are not served by this endpoint.")
    
    data_b64 = base64.b64encode(data).decode("ascii")
    return BlobDownloadResponse(dataB64=data_b64)



#-----------------------------------------------------------------------------------
# UPDATE APIS
#-----------------------------------------------------------------------------------
# TODO: PLACE HERE THE APIS TO UPDATE A CONVERSATION



#-----------------------------------------------------------------------------------
# DELETE CONVERSATION APIS
#-----------------------------------------------------------------------------------
@app.delete(
    "/users/{user_id}/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT
)
async def deleteConversation(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    db: AsyncSession = Depends(get_db)
):
    """Delete a conversation entirely (cascades to messages & attachments rows)."""
    await db.delete(current_conv)
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


