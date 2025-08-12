from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends, HTTPException

from database import get_db, UserTable, ConversationTable
from schemas import Conversation
from typing import List, Dict

import json
import httpx



async def authenticate_id(user_id: str, db: AsyncSession = Depends(get_db)) -> UserTable:
    """Generic authenticator by user id"""
    result = await db.execute(
        select(UserTable).filter_by(id=user_id)
    )
    user: UserTable | None = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(401, "Invalid or unknown user")
    return user


async def upsert_conversation(payload: Conversation, db: AsyncSession) -> ConversationTable:
    """Create or update the ConversationTable row, then return it."""
    try:
        # Assign a random ID if none provided
        if payload.conversation_id is None:
            payload.conversation_id = uuid.uuid4().hex
        
        # Look for an existing conversation record
        result = await db.execute(
            select(ConversationTable).filter_by(
                user_id=payload.user_id,
                conversation_id=payload.conversation_id,
            )
        )
        
        # If found, update it, if not, create a new one
        convo = result.scalar_one_or_none()
        if convo is None:
            convo = ConversationTable(
                user_id=payload.user_id,
                conversation_id=payload.conversation_id,
                title=payload.title,
                messages=payload.messages,
                agents=payload.agents,
            )
            db.add(convo)
        else:
            convo.messages = payload.messages
            convo.agents = convo.agents + payload.agents
            if payload.title and payload.title != convo.title:
                convo.title = payload.title
        
        # Persist changes
        await db.commit()
        await db.refresh(convo)
        return convo
    
    except IntegrityError as e:
        if "conversations_user_id_fkey" in str(e.orig):
            raise HTTPException(400, "Cannot create conversation for non-existent user")
        raise  # re-raise any other DB error


async def agent_stream(agent_url: str, payload: Conversation, db: AsyncSession):
    """
    Stream chunks from an external agent service and persist the full conversation.
    Yields UTF-8-encoded JSON lines with either 'reasoning' or 'response' messages.
    """
    current_node: str | None = None
    reasoning_cells: List[Dict[str, str]] = []
    response_accum: str = ""
    
    try:
        # Make the streaming request to the agent
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST",
                agent_url,
                headers={"Content-Type":"application/json"},
                json={"user_input": payload.messages},
                timeout=None
            ) as resp:
                
                # Iterate over each line of the agent’s streaming response
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    
                    try:
                        chunk = json.loads(line)
                        ctype = chunk.get('type')
                        content = chunk.get("content")
                            
                        if ctype in ("reasoning", "reasoning_chunk"):
                            node = chunk.get("node", "unknown_node")
                            
                            if node != current_node:
                                reasoning_cells.append({
                                    "node": node,
                                    "chunks": ''
                                })
                                current_node = node
                                
                            reasoning_cells[-1]["chunks"] = content
                            
                            yield (json.dumps({
                                "type": "reasoning",
                                "node": node,
                                "content": content
                            }) + "\n").encode("utf-8")
                            
                        elif ctype in ("response", "response_chunk"):
                            response_accum += content
                            
                            yield (json.dumps({
                                "type": "response",
                                "content": content
                            }) + "\n").encode("utf-8")
                        
                    except Exception as ex:
                        raise HTTPException(500, ex)
        
        # Once streaming is done, append the assistant message and save to DB
        assistant_message = {
            "role": "assistant",
            "content": response_accum,
            "reasoning": json.dumps(reasoning_cells)
        }
        
        new_payload = Conversation(
            user_id=payload.user_id,
            conversation_id=payload.conversation_id,
            title=payload.title,
            messages=[*payload.messages,  assistant_message],
            agents=payload.agents
        )
        _ = await upsert_conversation(new_payload, db)
        
    except httpx.HTTPError as exc:
        # Propagate HTTP errors as generic exceptions
        raise Exception(exc)
    finally:
        # Ensure resources are cleaned up
        await client.aclose()
        await db.close()



