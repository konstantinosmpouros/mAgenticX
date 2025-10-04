import base64
from typing import Optional, List, Dict, Iterable

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import Depends, HTTPException

from langchain.schema import SystemMessage, HumanMessage
from langchain_openai import ChatOpenAI

from database import (
    get_db,
    AgentTable,
    UserTable,
    ConversationTable,
    MessageTable,
    AttachmentTable,
    BlobTable
)

from schemas import (
    MessageIn,
    AttachmentIn,
    TitleOut,
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


async def validate_userId(user_id: str, db: AsyncSession = Depends(get_db)) -> UserTable:
    """Generic authenticator by user id"""
    result = await db.execute(
        select(UserTable).filter_by(id=user_id)
    )
    user: UserTable | None = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(401, "Invalid or unknown user")
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
                "image_url": data_url,
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


async def generate_title(message: MessageIn, *, model: str = "gpt-4o", temperature: float = 0.2) -> Optional[str]:
    """
    Build a multimodal prompt from MessageIn and get a structured TitleOut from the LLM.
    - Includes the first text message (truncated)
    - Includes up to 2 image attachments as data-URLs so GPT-4o can see them
    - Lists other (non-image) attachment names as text context
    Returns a cleaned title or None if there is nothing to title.
    """
    def _is_image_mime(mime: Optional[str]) -> bool: return bool(mime and mime.lower().startswith("image/"))
    
    content = (message.content or "").strip()
    image_parts: List[dict] = []
    other_attachment_names: List[str] = []
    
    for a in (message.attachments or []):
        mime = getattr(a, "mime", None)
        name = getattr(a, "name", None)
        b64 = getattr(a, "dataB64", None)
        
        if _is_image_mime(mime) and b64:
            # image_url must be an OBJECT with a url key (and optional detail)
            data_url = f"data:{mime};base64,{b64}"
            image_parts.append({
                "type": "image_url",
                "image_url": {
                    "url": data_url,
                    "detail": "auto",
                },
            })
        elif name:
            other_attachment_names.append(name)
    
    # Build the textual payload (shown alongside images)
    parts = []
    if content:
        parts.append(f"First user message:\n{content}")
    if other_attachment_names:
        parts.append("Attachments (names):\n- " + "\n- ".join(other_attachment_names))
    parts.append("Produce only a succinct title that captures the request.")
    payload_text = "\n\n".join(parts)
    
    # System + Human (multimodal) messages
    system_prompt = (
        "You create concise, descriptive chat titles.\n"
        "Reply in English regardless of the language of the user's message "
        "(EXCEPTION: reply in Greek if the user's message is Greek).\n"
        "Aim for 3-5 words. Never use emojis, quotes, code fences, or trailing punctuation.\n"
        "Return only the title as plain text."
    )
    
    human_content = [{"type": "text", "text": payload_text}]
    if image_parts:
        human_content.extend(image_parts)
    
    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=human_content),
    ]
    
    llm = ChatOpenAI(model=model, temperature=temperature, max_tokens=32, timeout=12)
    structured = llm.with_structured_output(TitleOut)
    
    result: TitleOut = await structured.ainvoke(messages)
    return result.title or None


def _preview(text: Optional[str]) -> Optional[str]:
    MAX_PREVIEW_LEN = 50
    if not text:
        return None
    s = text.strip().replace("\r", " ").replace("\n", " ")
    return s[:MAX_PREVIEW_LEN]
