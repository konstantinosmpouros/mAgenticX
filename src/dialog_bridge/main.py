import json
import os
from typing import Any, Dict, List

import httpx
import redis.asyncio as redis
from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field


# Configuration helpers and redis client
REDIS_URL: str = os.getenv("REDIS_URL", "redis://redis:6379/0")
CHAT_TTL: int = int(os.getenv("CHAT_TTL", "86400"))
redis_client: redis.Redis = redis.from_url(REDIS_URL, decode_responses=True)


try:
    AGENT_MAP: Dict[str, str] = json.loads(os.getenv("AGENT_MAP", "{}"))
except json.JSONDecodeError as exc:
    raise RuntimeError("AGENT_MAP must be valid JSON - e.g. '{\"math\": \"http://agent_math:8000/chat\"}'") from exc

if not AGENT_MAP:
    # Fallback so the container starts even without a supplied map.
    AGENT_MAP = {"Orthodox_v1": "http://orthodox_agents:8081/OrthodoxAI/v1/stream"}


# Pydantic models
class ChatRequest(BaseModel):
    user_id: str
    conversation_id: str
    conversation: List[dict[str, Any]]
    agent_name: str = Field(..., description="Must exist in AGENT_MAP")


# Redis helpers
async def _redis_key(user_id: str, conv_id: str) -> str:
    """Return the canonical Redis key for a conversation."""
    return f"chat:{user_id}:{conv_id}"

async def append_history(user_id: str, conv_id: str, messages: List[dict[str, Any]]) -> None:
    """Push messages to the tail of the Redis list (RPUSH)."""
    if not messages:
        return
    key = await _redis_key(user_id, conv_id)
    await redis_client.rpush(key, *[json.dumps(m) for m in messages])
    await redis_client.expire(key, CHAT_TTL)

async def fetch_conversation(user_id: str, conv_id: str) -> List[dict[str, Any]]:
    """Retrieve a conversation as a list of message dicts (oldest → newest)."""
    key = await _redis_key(user_id, conv_id)
    raw = await redis_client.lrange(key, 0, -1)
    if not raw:
        return []
    return [json.loads(item) for item in raw]

async def fetch_all_conversations(user_id: str) -> Dict[str, List[dict[str, Any]]]:
    """Return **every** conversation for a user keyed by conversation_id."""
    pattern = f"chat:{user_id}:*"
    cursor = "0"
    conversations: Dict[str, List[dict[str, Any]]] = {}

    while True:
        cursor, keys = await redis_client.scan(cursor=cursor, match=pattern, count=100)
        for key in keys:
            *_, conv_id = key.split(":", 2)
            raw = await redis_client.lrange(key, 0, -1)
            conversations[conv_id] = [json.loads(item) for item in raw]
        if cursor == "0":
            break
    return conversations


# FastApi server
app = FastAPI(title="DialogBridge", version="0.2.0")


@app.get("/conversations/{user_id}/{conversation_id}")
async def get_conversation(user_id: str, conversation_id: str):
    """Return a single conversation thread."""
    convo = await fetch_conversation(user_id, conversation_id)
    if not convo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return JSONResponse(content={"conversation_id": conversation_id, "messages": convo})


@app.delete("/conversations/{user_id}/{conversation_id}")
async def delete_conversation(user_id: str, conversation_id: str):
    """Delete an entire conversation thread from Redis."""

    key = await _redis_key(user_id, conversation_id)
    removed = await redis_client.delete(key)
    if removed == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    return {"status": "deleted", "conversation_id": conversation_id}


@app.post("/chat", response_class=StreamingResponse)
async def chat_endpoint(payload: ChatRequest):
    """Main entry-point hit by the UI - behaves like a transparent proxy."""
    # Persist user turn(s)
    await append_history(
        payload.user_id,
        payload.conversation_id,
        payload.conversation[-1:],
    )

    # Route to the correct agent
    agent_url = AGENT_MAP.get(payload.agent_name)
    if not agent_url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown agent_name")

    async def _proxy_stream():
        collected: list[dict[str, Any]] = []
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", agent_url, json=payload.model_dump()) as resp:
                if resp.status_code != 200:
                    detail = await resp.aread()
                    raise HTTPException(status_code=resp.status_code, detail=detail.decode())
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    yield json.dumps(line).encode("utf-8")
                    try:
                        data = json.loads(line)
                        if data.get("type") in {"response", "response_chunk"}:
                            collected.append(data)
                    except json.JSONDecodeError:
                        continue
        if collected:
            await append_history(payload.user_id, payload.conversation_id, collected)

    return StreamingResponse(_proxy_stream(), media_type="application/json")








# ---------------------------------------------------------------------------
# Minimal add & delete endpoints – enables isolated Redis tests
# ---------------------------------------------------------------------------

class AddMessagesRequest(BaseModel):
    """Payload for the unit‑test‑friendly add/upsert endpoint."""
    messages: List[Dict[str, Any]]

@app.post("/conversations/{user_id}/{conversation_id}/messages", status_code=status.HTTP_201_CREATED)
async def add_messages(user_id: str, conversation_id: str, payload: AddMessagesRequest):
    """Append messages to the specified conversation.

    • Creates the Redis list if it doesn't exist (acts as *upsert*).
    • Keeps the TTL fresh (same as the main chat workflow).
    """

    await append_history(user_id, conversation_id, payload.messages)
    return {"status": "ok", "added": len(payload.messages)}


@app.get("/conversations/{user_id}")
async def list_conversations(user_id: str):
    """Return **all** conversations (and their messages) for `user_id`."""
    conversations = await fetch_all_conversations(user_id)
    return JSONResponse(content=conversations)
