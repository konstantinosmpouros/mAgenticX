"""Internal agents-to-bridge DTOs for the semantic past-conversation memory search."""
from typing import Literal, Optional
from pydantic import BaseModel
from schema.base import UTCDateTime


class MemorySearchRequest(BaseModel):
    """Internal (agents → bridge) request: semantic search over a user's past
    messages, backing the agent's `search_past_conversations` tool. `user_id`
    is trusted because only internal callers (the agents service, with the
    proxy secret) can reach this endpoint."""
    user_id: str
    query: str
    limit: int = 5
    # The current conversation, excluded so the tool surfaces *other* (old)
    # conversations the agent doesn't already have in context.
    exclude_conversation_id: Optional[str] = None


class MemoryMessageMatch(BaseModel):
    """One past message returned to the agent's memory-search tool.

    ``createdAt``/``updatedAt`` are the matched **message's** timestamps."""
    messageId: str
    conversationId: str
    conversationTitle: str
    sender: Literal["user", "ai"]
    content: str
    score: float
    createdAt: Optional[UTCDateTime] = None
    updatedAt: Optional[UTCDateTime] = None
