from datetime import datetime
import base64
from typing import Optional, List

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

from schemas import (
    MessageIn,
    AttachmentIn
)


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


async def validate_agentId(db: AsyncSession, agent_id: str) -> AgentTable:
    q = select(AgentTable).where(
        AgentTable.id == agent_id,
        AgentTable.is_active == True
    )
    res = await db.execute(q)
    agent = res.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=400, detail="Unknown or inactive agent.")
    return agent


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


def _preview(text: Optional[str]) -> Optional[str]:
    MAX_PREVIEW_LEN = 50
    if not text:
        return None
    s = text.strip().replace("\r", " ").replace("\n", " ")
    return s[:MAX_PREVIEW_LEN]









# async def agent_stream(agent_url: str, payload: Conversation, db: AsyncSession):
#     """
#     Stream chunks from an external agent service and persist the full conversation.
#     Yields UTF-8-encoded JSON lines with either 'reasoning' or 'response' messages.
#     """
#     current_node: str | None = None
#     reasoning_cells: List[Dict[str, str]] = []
#     response_accum: str = ""
    
#     try:
#         # Make the streaming request to the agent
#         async with httpx.AsyncClient(timeout=None) as client:
#             async with client.stream(
#                 "POST",
#                 agent_url,
#                 headers={"Content-Type":"application/json"},
#                 json={"user_input": payload.messages},
#                 timeout=None
#             ) as resp:
                
#                 # Iterate over each line of the agent’s streaming response
#                 async for line in resp.aiter_lines():
#                     if not line:
#                         continue
                    
#                     try:
#                         chunk = json.loads(line)
#                         ctype = chunk.get('type')
#                         content = chunk.get("content")
                            
#                         if ctype in ("reasoning", "reasoning_chunk"):
#                             node = chunk.get("node", "unknown_node")
                            
#                             if node != current_node:
#                                 reasoning_cells.append({
#                                     "node": node,
#                                     "chunks": ''
#                                 })
#                                 current_node = node
                                
#                             reasoning_cells[-1]["chunks"] = content
                            
#                             yield (json.dumps({
#                                 "type": "reasoning",
#                                 "node": node,
#                                 "content": content
#                             }) + "\n").encode("utf-8")
                            
#                         elif ctype in ("response", "response_chunk"):
#                             response_accum += content
                            
#                             yield (json.dumps({
#                                 "type": "response",
#                                 "content": content
#                             }) + "\n").encode("utf-8")
                        
#                     except Exception as ex:
#                         raise HTTPException(500, ex)
        
#         # Once streaming is done, append the assistant message and save to DB
#         assistant_message = {
#             "role": "assistant",
#             "content": response_accum,
#             "reasoning": json.dumps(reasoning_cells)
#         }
        
#         new_payload = Conversation(
#             user_id=payload.user_id,
#             conversation_id=payload.conversation_id,
#             title=payload.title,
#             messages=[*payload.messages,  assistant_message],
#             agents=payload.agents
#         )
#         _ = await upsert_conversation(new_payload, db)
        
#     except httpx.HTTPError as exc:
#         # Propagate HTTP errors as generic exceptions
#         raise Exception(exc)
#     finally:
#         # Ensure resources are cleaned up
#         await client.aclose()
#         await db.close()



