import asyncio
import base64
from datetime import datetime
from typing import List

from fastapi import FastAPI, Depends, HTTPException, status, Header, Response
from fastapi.responses import StreamingResponse
import httpx
from contextlib import asynccontextmanager

from sqlalchemy import select, func, desc, text
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi_pagination import add_pagination, Page
from fastapi_pagination.ext.sqlalchemy import paginate

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
    ConversationIn, MessageIn, MessageOut,
    UpdateConversationResponse,
    ImageOut,
    AuthRequest, AuthResponse,
    AgentPublic,
)
from utils import (
    validate_userId,
    validate_convId,
    validate_convId_full,
    validate_agentId,
    prime_agent_cache,
    get_cached_agents,
    init_conv,
    init_message,
    _preview,
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

        result = await session.execute(
            select(AgentTable).where(AgentTable.is_active == True)
        )
        agents = list(result.scalars().all())
        prime_agent_cache(agents)

    yield

app = FastAPI(title="Bridge Service", lifespan=lifespan)
add_pagination(app)


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
            user.last_login_at = datetime.utcnow()
            await db.commit()
            await db.refresh(user)
            return AuthResponse(authenticated=True, user_id=user.id, user=user)
        return AuthResponse()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



#-----------------------------------------------------------------------------------
# CREATE APIS
#-----------------------------------------------------------------------------------
@app.post(
    "/users/{user_id}/conversations",
    response_model=CreateConversationResponse,
    status_code=status.HTTP_201_CREATED
)
async def createConversation(
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
        # Do all inserts/flushes
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
@app.get("/agents", response_model=List[AgentPublic], status_code=status.HTTP_200_OK)
async def getAvailableAgents(db: AsyncSession = Depends(get_db)):
    """
    Fetch active agents from the cache, falling back to the database if needed.
    """
    agents = get_cached_agents()
    if not agents:
        result = await db.execute(
            select(AgentTable).where(AgentTable.is_active == True)
        )
        agents = list(result.scalars().all())
        if agents:
            prime_agent_cache(agents)
    return [AgentPublic.model_validate(a) for a in agents]


@app.get(
    "/users/{user_id}/conversations",
    response_model=Page[ConversationSummary],
    status_code=status.HTTP_200_OK
)
async def getConvsSummary(
    user_id: str,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db)
):
    """
    Return a paginated conversation summary list for the user.
    Use query params: ?page=1&size=50
    """
    # fetch all full rows statement
    stmt = (
        select(ConversationTable)
        .where(
            ConversationTable.user_id == user_id,
            ConversationTable.is_private == False,
        )
        .order_by(ConversationTable.updated_at.desc())
    )
    return await paginate(db, stmt)


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


@app.get(
    "/users/{user_id}/conversations/{conversation_id}/messages/{message_id}/blobs/{blob_id}",
)
async def downloadBlobStream(
    user_id: str,
    conversation_id: str,
    message_id: str,
    blob_id: str,
    range_header: str | None = Header(default=None, alias="Range"),
    db: AsyncSession = Depends(get_db),
):
    """
    Stream a blob (non-image) with HTTP byte-range support.
    Returns 200 for full content or 206 for partial content.
    """
    # Validate ownership and get data + metadata
    result = await db.execute(
        select(BlobTable.data, AttachmentTable.mime_type, AttachmentTable.file_name)
        .join(AttachmentTable, AttachmentTable.blob_id == BlobTable.id)
        .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            BlobTable.id == blob_id,
            AttachmentTable.message_id == message_id,
            MessageTable.id == message_id,
            MessageTable.conversation_id == conversation_id,
            ConversationTable.id == conversation_id,
            ConversationTable.user_id == user_id,
        )
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Blob not found or not accessible.")

    data: bytes = row.data
    mime: str | None = row.mime_type
    file_name: str | None = row.file_name

    if mime and mime.startswith("image/"):
        raise HTTPException(status_code=400, detail="Images are not served by this endpoint.")

    file_size = len(data)

    def encode_disposition(name: str | None) -> str:
        name = name or "download"
        try:
            name.encode("ascii")
            return f'attachment; filename="{name}"'
        except Exception:
            from urllib.parse import quote
            return f"attachment; filename*=UTF-8''{quote(name)}"

    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": encode_disposition(file_name),
    }

    # Full content
    if not range_header:
        def iter_full():
            CHUNK = 1024 * 1024
            for i in range(0, file_size, CHUNK):
                yield data[i:i + CHUNK]

        headers = dict(base_headers)
        headers["Content-Length"] = str(file_size)
        return StreamingResponse(iter_full(), media_type=mime or "application/octet-stream", headers=headers)

    # Parse Range: bytes=start-end
    try:
        units, rng = range_header.split("=")
        if units.strip().lower() != "bytes":
            raise ValueError
        start_s, end_s = [s.strip() for s in rng.split("-")]
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
        if start > end or start < 0 or end >= file_size:
            raise ValueError
    except Exception:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    content_length = end - start + 1
    headers = dict(base_headers)
    headers.update({
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(content_length),
    })

    def iter_range():
        CHUNK = 1024 * 1024
        i = start
        while i <= end:
            yield data[i:min(i + CHUNK, end + 1)]
            i += CHUNK

    return StreamingResponse(
        iter_range(),
        status_code=206,
        media_type=mime or "application/octet-stream",
        headers=headers,
    )


@app.get(
    "/users/{user_id}/images",
    response_model=Page[ImageOut],
    status_code=status.HTTP_200_OK,
)
async def getImagesBatch(
    user_id: str,
    current_user: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """
    Paginated image retrieval for a user. Use query params `page` and `size`.
    Returns base64-encoded image data with metadata. The `total` field on the
    Page response can be used instead of a separate summary endpoint.
    """
    stmt = (
        select(
            BlobTable.id.label("blob_id"),
            AttachmentTable.id.label("attachment_id"),
            AttachmentTable.file_name,
            AttachmentTable.mime_type,
            AttachmentTable.created_at,
            BlobTable.data,
        )
        .join(AttachmentTable, AttachmentTable.blob_id == BlobTable.id)
        .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            ConversationTable.user_id == user_id,
            AttachmentTable.mime_type.like("image/%"),
        )
        .order_by(desc(AttachmentTable.created_at))
    )
    
    pages = await paginate(db, stmt)
    
    items = [
        ImageOut(
            blob_id=r.blob_id,
            attachment_id=r.attachment_id,
            file_name=r.file_name,
            mime_type=r.mime_type,
            created_at=r.created_at,
            dataB64=base64.b64encode(r.data).decode(),
        )
        for r in pages.items
    ]
    
    return Page[ImageOut](
        items=items, total=pages.total, page=pages.page, size=pages.size
    )



#-----------------------------------------------------------------------------------
# UPDATE APIS
#-----------------------------------------------------------------------------------
@app.post(
    "/users/{user_id}/conversations/{conversation_id}/messages",
    response_model=UpdateConversationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def addMessageToConversation(
    user_id: str,
    conversation_id: str,
    payload: MessageIn,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),  # cheap variant, no eager-loading
    db: AsyncSession = Depends(get_db),
) -> UpdateConversationResponse:
    """
    Append a new message (optionally with attachments) to an existing conversation.
    Returns only the appended message (with attachments) and the updated sidebar summary.
    """
    try:
        # 1) Persist the new message and capture it
        msg = await init_message(db, current_conv, payload)
        
        # 2) Bump conversation metadata
        current_conv.last_message_preview = (
            _preview(payload.content) or
            (payload.attachments[0].name if payload.attachments else None)
        )
        current_conv.last_message_at = datetime.now()
        
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    
    # 3) Load only the inserted message with attachments (including blobs for images)
    stmt = (
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(MessageTable.id == msg.id)
    )
    result = await db.execute(stmt)
    msg_row = result.scalar_one_or_none()
    
    if not msg_row:
        conv_full = await validate_convId_full(user_id, conversation_id, db)
        message_out = MessageOut.model_validate(conv_full.messages[-1])
        summary = ConversationSummary.model_validate(conv_full)
        return UpdateConversationResponse(message=message_out, summary=summary)

    # Refresh conversation row so auto-updated columns (e.g., updated_at) are loaded
    message_out = MessageOut.model_validate(msg_row)
    await db.refresh(current_conv)
    summary = ConversationSummary.model_validate(current_conv)
    
    return UpdateConversationResponse(message=message_out, summary=summary)


@app.post(
    "/users/{user_id}/conversations/{conversation_id}/messages/{message_id}/like",
    response_model=MessageOut,
    status_code=status.HTTP_200_OK,
)
async def likeMessage(
    user_id: str,
    conversation_id: str,
    message_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    db: AsyncSession = Depends(get_db),
):
    # Load message within the validated conversation, including attachments for UI consistency
    stmt = (
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(
            MessageTable.id == message_id,
            MessageTable.conversation_id == conversation_id,
        )
    )
    res = await db.execute(stmt)
    msg = res.scalar_one_or_none()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")
    
    # Toggle semantics: clicking like again clears the reaction
    msg.liked = None if msg.liked is True else True
    await db.commit()
    await db.refresh(msg)
    return MessageOut.model_validate(msg)


@app.post(
    "/users/{user_id}/conversations/{conversation_id}/messages/{message_id}/dislike",
    response_model=MessageOut,
    status_code=status.HTTP_200_OK,
)
async def dislikeMessage(
    user_id: str,
    conversation_id: str,
    message_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(
            MessageTable.id == message_id,
            MessageTable.conversation_id == conversation_id,
        )
    )
    res = await db.execute(stmt)
    msg = res.scalar_one_or_none()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found.")
    
    # Toggle semantics: clicking dislike again clears the reaction
    msg.liked = None if msg.liked is False else False
    await db.commit()
    await db.refresh(msg)
    return MessageOut.model_validate(msg)



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
# INFERENCE STREAM (SSE PROXY)
#-----------------------------------------------------------------------------------
@app.post(
    "/users/{user_id}/conversations/{conversation_id}/inference/stream",
)
async def startInferenceStream(
    user_id: str,
    conversation_id: str,
    current_user: UserTable = Depends(validate_userId),
    current_conv: ConversationTable = Depends(validate_convId_full),
    db: AsyncSession = Depends(get_db),
):
    """
    Proxy an inference stream from the selected agent to the UI as SSE.
    - Builds chat history for the agent as List[Dict[str, str]] (role/content only).
    - Looks up the agent URL from the conversation's agent.
    - POSTs to the agent stream endpoint and forwards bytes as-is.
    Attachments are not sent to the agent.
    """
    # Resolve agent URL
    agent_url = None
    result = await db.execute(select(AgentTable.url).where(AgentTable.id == current_conv.agent_id))
    row = result.one_or_none()
    if row and row[0]:
        agent_url = row[0]
    else:
        raise HTTPException(status_code=500, detail="Agent URL not found for this conversation")
    
    # Build full chat history (role/content only)
    history = []
    for m in current_conv.messages:
        role = "user" if m.sender == "user" else "assistant"
        content = m.content or ""
        history.append({"role": role, "content": content})
    
    async def event_stream():
        timeout = httpx.Timeout(60.0, connect=30.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                try:
                    async with client.stream(
                        "POST",
                        agent_url,
                        json={"user_input": history},
                        headers={"Accept": "text/event-stream"},
                    ) as r:
                        r.raise_for_status()
                        async for chunk in r.aiter_bytes():
                            # Forward bytes directly (pre-encoded SSE from the agents service)
                            yield chunk
                except asyncio.CancelledError:
                    # Client interrupted streaming; exit silently to avoid noisy logs
                    return
        except asyncio.CancelledError:
            # Request context cancelled (e.g., UI aborted). Exit quietly.
            return
        except httpx.HTTPError as e:
            # Emit a RUN_ERROR frame so UI can gracefully handle upstream failures
            import json as _json
            err = {"type": "RUN_ERROR", "message": str(e)}
            data = "data: " + _json.dumps(err, ensure_ascii=False) + "\n\n"
            yield data.encode("utf-8")

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)




