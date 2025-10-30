import json
import asyncio
import base64
import os
import traceback
from datetime import datetime
from typing import List

from fastapi import FastAPI, Depends, HTTPException, status, Header, Response
from fastapi.responses import StreamingResponse
import httpx
from contextlib import asynccontextmanager

from sqlalchemy import select, func, desc, text, or_
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi_pagination import add_pagination, Page
from fastapi_pagination.ext.sqlalchemy import paginate

from database import (
    Base, engine, get_db,
    seed_agents, upsert_user_from_vault,
    UserTable,
    AgentTable,
    ConversationTable,
    MessageTable,
    AttachmentTable,
    BlobTable,
)
from vault_auth.client import VaultAuthenticator, VaultAuthError
from database.schemas import (
    ConversationDetail, ConversationSummary, CreateConversationResponse,
    ConversationIn, MessageIn, MessageOut,
    UpdateConversationResponse,
    ImageOut,
    AuthRequest, AuthResponse,
    AgentPublic,
)
from utils import (
    serialise_message_with_images_for_agent,
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
from vault_auth.auth import (
    SESSION_COOKIE_DOMAIN,
    SESSION_COOKIE_NAME,
    SESSION_COOKIE_SAMESITE,
    SESSION_COOKIE_SECURE,
    SESSION_REFRESH_COOKIE_NAME,
    TokenVerificationError,
    get_jwt_verifier,
    require_refresh_token,
    require_token_claims,
)

_vault_authenticator: VaultAuthenticator | None = None
_DEFAULT_TOKEN_TTL = int(os.getenv("SESSION_COOKIE_DEFAULT_TTL", "3600"))


def get_vault_authenticator() -> VaultAuthenticator:
    global _vault_authenticator
    if _vault_authenticator is None:
        _vault_authenticator = VaultAuthenticator()
    return _vault_authenticator


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1) Initialize the database schema if its not
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    # 2) Seed users & agents, then demo data
    async with AsyncSession(engine) as session:
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
async def authenticate(
    creds: AuthRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """
    Authenticate the user against Vault, ensure they exist locally, and return a JWT.
    """
    try:
        authenticator = get_vault_authenticator()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    try:
        auth_result = await authenticator.authenticate(creds.username, creds.password)
    except VaultAuthError as exc:
        status_code = exc.status_code or status.HTTP_500_INTERNAL_SERVER_ERROR
        if status_code < 400 or status_code >= 500:
            status_code = status.HTTP_502_BAD_GATEWAY
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    login_time = datetime.utcnow()

    user = await upsert_user_from_vault(
        db,
        vault_user_id=auth_result.vault_user_id,
        username=auth_result.username,
        metadata={"last_login_at": login_time},
    )

    user.last_login_at = login_time
    await db.commit()
    await db.refresh(user)

    max_age = auth_result.ttl if auth_result.ttl and auth_result.ttl > 0 else _DEFAULT_TOKEN_TTL
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=auth_result.jwt,
        max_age=max_age,
        expires=max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=SESSION_COOKIE_DOMAIN,
        path="/",
    )

    refresh_max_age = auth_result.client_token_ttl if auth_result.client_token_ttl and auth_result.client_token_ttl > 0 else max_age
    response.set_cookie(
        key=SESSION_REFRESH_COOKIE_NAME,
        value=auth_result.client_token,
        max_age=refresh_max_age,
        expires=refresh_max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=SESSION_COOKIE_DOMAIN,
        path="/",
    )

    return AuthResponse(
        authenticated=True,
        user_id=user.id,
        user=user,
        tokenTtl=auth_result.ttl,
        vaultUserId=auth_result.vault_user_id,
    )


@app.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> Response:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        domain=SESSION_COOKIE_DOMAIN,
    )
    response.delete_cookie(
        key=SESSION_REFRESH_COOKIE_NAME,
        path="/",
        domain=SESSION_COOKIE_DOMAIN,
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@app.post("/session/refresh", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def refresh_session(
    response: Response,
    refresh_token: str = Depends(require_refresh_token),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    try:
        authenticator = get_vault_authenticator()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    try:
        refresh_result = await authenticator.refresh_session(refresh_token)
    except VaultAuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    try:
        verifier = get_jwt_verifier()
        claims = await verifier.verify(refresh_result.jwt)
    except (RuntimeError, TokenVerificationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc

    identifiers: set[str] = set()
    for key in ("sub", "entity_id", "user_id", "id"):
        value = claims.get(key)
        if value is not None:
            identifiers.add(str(value))
    metadata = claims.get("metadata")
    if isinstance(metadata, dict):
        for key in ("vault_user_id", "user_id", "id"):
            value = metadata.get(key)
            if value is not None:
                identifiers.add(str(value))

    if not identifiers:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token missing subject identifiers.",
        )

    stmt = select(UserTable).where(
        or_(
            UserTable.id.in_(identifiers),
            UserTable.vault_user_id.in_(identifiers),
        )
    )
    result = await db.execute(stmt)
    user: UserTable | None = result.scalars().first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not recognised for refreshed token.",
        )

    max_age = refresh_result.ttl if refresh_result.ttl and refresh_result.ttl > 0 else _DEFAULT_TOKEN_TTL
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=refresh_result.jwt,
        max_age=max_age,
        expires=max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=SESSION_COOKIE_DOMAIN,
        path="/",
    )

    refresh_max_age = refresh_result.client_token_ttl if refresh_result.client_token_ttl and refresh_result.client_token_ttl > 0 else max_age
    response.set_cookie(
        key=SESSION_REFRESH_COOKIE_NAME,
        value=refresh_token,
        max_age=refresh_max_age,
        expires=refresh_max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=SESSION_COOKIE_DOMAIN,
        path="/",
    )

    return AuthResponse(
        authenticated=True,
        user_id=user.id,
        user=user,
        tokenTtl=refresh_result.ttl,
        vaultUserId=user.vault_user_id,
    )



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
async def getAvailableAgents(
    _: dict = Depends(require_token_claims),
    db: AsyncSession = Depends(get_db),
):
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
    _current_user: UserTable = Depends(validate_userId),
    range_header: str | None = Header(default=None, alias="Range"),
    db: AsyncSession = Depends(get_db),
):
    """
    Stream a blob (non-image) with HTTP byte-range support.
    Returns 200 for full content or 206 for partial content.
    """
    # Validate ownership and get data + metadata
    result = await db.execute(
        select(
            AttachmentTable.mime_type,
            AttachmentTable.file_name,
            func.coalesce(
                AttachmentTable.size_bytes,
                func.octet_length(BlobTable.data)
            ).label("blob_size"),
        )
        .select_from(BlobTable)
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
    row = result.mappings().one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Blob not found or not accessible.")

    mime: str | None = row["mime_type"]
    file_name: str | None = row["file_name"]
    file_size: int | None = row["blob_size"]

    if mime and mime.startswith("image/"):
        raise HTTPException(status_code=400, detail="Images are not served by this endpoint.")

    if file_size is None:
        raise HTTPException(status_code=500, detail="Unable to determine blob size.")

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

    CHUNK = 1024 * 512

    async def stream_range(start: int, end: int):
        pos = start
        while pos <= end:
            length = min(CHUNK, end - pos + 1)
            chunk_result = await db.execute(
                select(func.substring(BlobTable.data, pos + 1, length))
                .select_from(BlobTable)
                .where(BlobTable.id == blob_id)
            )
            chunk = chunk_result.scalar_one_or_none()
            if not chunk:
                break
            if isinstance(chunk, memoryview):
                chunk = chunk.tobytes()
            else:
                chunk = bytes(chunk)
            yield chunk
            pos += len(chunk)
    
    # Full content
    if not range_header:
        headers = dict(base_headers)
        headers["Content-Length"] = str(file_size)
        return StreamingResponse(
            stream_range(0, file_size - 1),
            media_type=mime or "application/octet-stream",
            headers=headers,
        )
    
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
    
    return StreamingResponse(
        stream_range(start, end),
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
    current_conv: ConversationTable = Depends(validate_convId),
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
    Image attachments are forwarded to the agent as base64 data URLs.
    """
    # Resolve agent URL
    agent_url = None
    agent = await validate_agentId(db, current_conv.agent_id)
    agent_url = agent.url if agent else None
    if not agent_url:
        raise HTTPException(status_code=500, detail="Agent URL not found for this conversation")
    
    # Build full chat history (role/content only)
    history = [serialise_message_with_images_for_agent(m) for m in current_conv.messages]
    
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
            tb = traceback.format_exc()
            message = tb.strip() if tb and tb.strip() and tb.strip() != "NoneType: None" else f"{type(e).__name__}: {e}"
            err = {"type": "RUN_ERROR", "message": message}
            data = "data: " + json.dumps(err, ensure_ascii=False) + "\n\n"
            yield data.encode("utf-8")

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)




