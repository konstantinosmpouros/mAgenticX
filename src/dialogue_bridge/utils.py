import base64
from typing import Optional, List, Dict, Iterable, Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import Depends, HTTPException

from database import (
    get_db,
    AgentTable,
    UserTable,
    ConversationTable,
    MessageTable,
    AttachmentTable,
    BlobTable
)
from vault_auth.auth import require_token_claims

from database.schemas import (
    MessageIn,
    AttachmentIn,
)


_AGENT_CACHE: Dict[str, AgentTable] = {}


def prime_agent_cache(agents: Iterable[AgentTable]) -> None:
    """Store active agents for fast validation lookups."""
    global _AGENT_CACHE
    _AGENT_CACHE = {agent.id: agent for agent in agents if getattr(agent, 'is_active', True)}


def get_cached_agents() -> List[AgentTable]:
    """Return cached active agents; empty list if cache not yet primed."""
    return list(_AGENT_CACHE.values())


async def validate_agentId(db: AsyncSession, agent_id: str) -> AgentTable:
    agent = _AGENT_CACHE.get(agent_id)
    if agent is not None:
        return agent

    q = select(AgentTable).where(
        AgentTable.id == agent_id,
        AgentTable.is_active == True
    )
    res = await db.execute(q)
    agent = res.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=400, detail="Unknown or inactive agent.")

    _AGENT_CACHE[agent.id] = agent
    return agent


async def validate_userId(
    user_id: str,
    token_claims: Dict[str, Any] = Depends(require_token_claims),
    db: AsyncSession = Depends(get_db)
) -> UserTable:
    """Ensure the caller's JWT authorises access to the requested user."""
    result = await db.execute(
        select(UserTable).filter_by(id=user_id)
    )
    user: UserTable | None = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(401, "Invalid or unknown user")

    identifiers: set[str] = set()
    candidate_values = [
        token_claims.get("sub"),
        token_claims.get("entity_id"),
        token_claims.get("user_id"),
        token_claims.get("id"),
    ]
    metadata = token_claims.get("metadata")
    if isinstance(metadata, dict):
        candidate_values.extend(
            metadata.get(key)
            for key in ("vault_user_id", "user_id", "id")
        )

    for value in candidate_values:
        if value is None:
            continue
        identifiers.add(str(value))

    if not identifiers:
        raise HTTPException(
            status_code=403,
            detail="Token missing subject identifiers.",
        )

    if (
        str(user.vault_user_id) not in identifiers
        and str(user.id) not in identifiers
    ):
        raise HTTPException(
            status_code=403,
            detail="Token does not grant access to this user.",
        )
    return user


async def validate_convId(user_id: str, conversation_id: str, db: AsyncSession = Depends(get_db)) -> ConversationTable:
    q = select(ConversationTable).where(
        ConversationTable.id == conversation_id,
        ConversationTable.user_id == user_id,
    )
    res = await db.execute(q)
    conv: ConversationTable | None = res.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conv


async def validate_convId_full(user_id: str, conversation_id: str, db: AsyncSession = Depends(get_db)) -> ConversationTable:
    q = (
        select(ConversationTable)
        .options(
            selectinload(ConversationTable.messages)
            .selectinload(MessageTable.attachments)
            .selectinload(AttachmentTable.blob)
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


async def init_conv(db: AsyncSession, user: UserTable, agent: AgentTable, is_private: bool, title: Optional[str], first_message: MessageIn) -> ConversationTable:
    # Create conversation shell
    conv = ConversationTable(
        user_id=user.id,
        agent_id=agent.id,
        agent_name=agent.name,
        is_private=is_private,
        title=title,
        last_message_preview=_preview(first_message.content) or (
            first_message.attachments[0].name if first_message.attachments else None
        ),
    )
    db.add(conv)
    await db.flush()  # assign conv.id
    
    # Persist first message
    await init_message(db, conv, first_message)
    
    return conv


async def init_message(db: AsyncSession, conv: ConversationTable, payload: MessageIn) -> MessageTable:
    # Build row
    msg = MessageTable(
        conversation_id=conv.id,
        sender=payload.sender,
        type=payload.type,
        content=payload.content,
        reasoning_steps=payload.thinking,
        reasoning_time_seconds=payload.thinkingTime,
        is_error=bool(payload.error) if payload.error is not None else False,
        error_message=payload.errorMessage,
    )
    db.add(msg)
    await db.flush()  # assign msg.id

    # Persist attachments (if any)
    if payload.attachments:
        await init_attachments(db, msg.id, payload.attachments)

    return msg


async def init_attachments(db: AsyncSession, message_id: str, items: List[AttachmentIn]) -> None:
    # Create attachment rows with blobs
    for item in items:
        try:
            raw = base64.b64decode(item.dataB64, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Attachment '{item.name}' is not valid base64.")
        blob = BlobTable(data=raw)
        attach = AttachmentTable(
            message_id=message_id,
            file_name=item.name,
            mime_type=item.mime,
            size_bytes=item.size if item.size is not None else len(raw),
            blob=blob,
        )
        db.add(attach)


def serialise_message_with_images_for_agent(msg):
    """Convert a MessageTable (with attachments) into a LangChain message with multimodal content.
    - Images are embedded as data-URLs
    - Other attachments are listed by name in a text block
    """
    # Get main parts
    role = "user" if msg.sender == "user" else "ai"
    text_content = (msg.content or "").strip()
    attachments = getattr(msg, "attachments", []) or []
    
    content_parts = []
    other_attachment_notes = []
    
    if text_content:
        content_parts.append({"type": "text", "text": text_content})

    for attachment in attachments:
        mime = (getattr(attachment, "mime_type", None) or "").lower()
        blob = getattr(attachment, "blob", None)
        data_bytes = getattr(blob, "data", None) if blob is not None else None

        if mime.startswith("image/") and data_bytes:
            data_b64 = base64.b64encode(data_bytes).decode("ascii")
            data_url = f"data:{mime};base64,{data_b64}"
            content_parts.append({
                "type": "image_url",
                "image_url": {
                    "url": data_url,
                    "detail": "auto",
                },
            })
        else:
            name = getattr(attachment, "file_name", None)
            if name:
                label = f"{name} ({attachment.mime_type})" if getattr(attachment, "mime_type", None) else name
                other_attachment_notes.append(label)

    if other_attachment_notes:
        attachment_text = "Attachments:\n" + "\n".join(f"- {note}" for note in other_attachment_notes)
        content_parts.append({"type": "text", "text": attachment_text})

    if not content_parts:
        content_parts.append({"type": "text", "text": ""})

    if len(content_parts) == 1 and content_parts[0]["type"] == "text":
        content_payload = content_parts[0]["text"]
    else:
        content_payload = content_parts

    return {"role": role, "content": content_payload}


def _preview(text: Optional[str]) -> Optional[str]:
    MAX_PREVIEW_LEN = 40
    if not text:
        return None
    s = text.strip().replace("\r", " ").replace("\n", " ")
    return s[:MAX_PREVIEW_LEN]

