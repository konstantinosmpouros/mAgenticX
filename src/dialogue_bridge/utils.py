import base64
import logging
import os
from typing import Optional, List, Dict, Iterable, Any, Sequence

import httpx
from sqlalchemy import select, update
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.sql import func

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


logger = logging.getLogger(__name__)

AGENTS_SERVICE_URL = os.getenv("AGENTS_SERVICE_URL", "http://agents:8003")
_AGENTS_DISCOVERY_ENDPOINT = f"{AGENTS_SERVICE_URL.rstrip('/')}/agents"
_AGENT_CACHE: Dict[str, AgentTable] = {}


def prime_agent_cache(agents: Iterable[AgentTable]) -> None:
    """Store active agents for fast validation lookups."""
    global _AGENT_CACHE
    _AGENT_CACHE = {agent.id: agent for agent in agents if getattr(agent, 'is_active', True)}


def get_cached_agents() -> List[AgentTable]:
    """Return cached active agents; empty list if cache not yet primed."""
    return list(_AGENT_CACHE.values())


def build_agent_stream_url(slug: str) -> str:
    """Return the streaming endpoint for a given agent slug."""
    return f"{AGENTS_SERVICE_URL.rstrip('/')}/agents/{slug}/stream"


async def _load_active_agents(db: AsyncSession) -> List[AgentTable]:
    result = await db.execute(select(AgentTable).where(AgentTable.is_active == True))
    return list(result.scalars().all())


async def sync_agents_with_service(db: AsyncSession) -> List[AgentTable]:
    """
    Discover agents from the agents service, upsert them into the database, and
    toggle their active status. If the agents service is unreachable, fall back
    to the currently active agents stored in the database.
    """
    # Fetch agent manifests from the agents service
    manifests: Sequence[Dict[str, Any]] | None = None
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(_AGENTS_DISCOVERY_ENDPOINT)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list):
                manifests = data
            else:
                logger.warning("Unexpected agents payload shape: %s", type(data).__name__)
    except httpx.HTTPError as exc:
        logger.warning("Failed to refresh agents from service: %s", exc)
        raise HTTPException(503, "Agents service unreachable for agent synchronization.") from exc

    # Upsert discovered agents into the database
    manifest_ids: set[str] = set()
    for manifest in manifests:
        agent_id = manifest.get("id")
        slug = manifest.get("slug") or manifest.get("name") or agent_id
        if not agent_id or not slug:
            logger.warning("Skipping agent manifest missing id/slug: %s", manifest)
            continue
        manifest_ids.add(str(agent_id))

        stmt = (
            insert(AgentTable)
            .values(
                id=str(agent_id),
                slug=str(slug),
                name=manifest.get("name") or str(agent_id),
                description=manifest.get("description") or "",
                icon=manifest.get("icon") or "",
                version=manifest.get("version"),
                is_active=True,
            )
            .on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "slug": str(slug),
                    "name": manifest.get("name") or str(agent_id),
                    "description": manifest.get("description") or "",
                    "icon": manifest.get("icon") or "",
                    "version": manifest.get("version"),
                    "is_active": True,
                    "updated_at": func.now(),  # type: ignore[name-defined]
                },
            )
        )
        await db.execute(stmt)

    # Deactivate agents not present in the latest manifests
    if manifest_ids:
        await db.execute(
            update(AgentTable)
            .where(AgentTable.id.notin_(list(manifest_ids)))
            .values(is_active=False)
        )
    else:
        await db.execute(update(AgentTable).values(is_active=False))


    # Commit changes
    await db.commit()

    # Load and cache active agents
    refreshed = await _load_active_agents(db)
    prime_agent_cache(refreshed)
    return refreshed


async def get_agent_by_id(agent_id: str) -> AgentTable | None:
    """Fetch an agent from cache or database without enforcing validation semantics."""
    agent = _AGENT_CACHE.get(agent_id)
    if agent is not None and getattr(agent, "is_active", True):
        return agent

    # Cache should always be populated during startup sync; return None if not found.
    return None


async def validate_userId(
    user_id: str,
    token_claims: Dict[str, Any] = Depends(require_token_claims),
    db: AsyncSession = Depends(get_db)
) -> UserTable:
    """Ensure the caller's JWT authorizes access to the requested user."""
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
    q = (
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
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


async def validate_convId_full(user_id: str, conversation_id: str, db: AsyncSession = Depends(get_db)) -> ConversationTable:
    q = (
        select(ConversationTable)
        .options(
            selectinload(ConversationTable.agent),
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

