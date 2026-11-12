"""Bridge ↔ agents: a conversation's sources (plan 42 §3.7).

The bridge reads them when it loads a conversation (the map an inline
``[src:ID]`` citation resolves against), gives a fork its source's, and deletes
them with the conversation. Every item is validated by
:class:`harness.sources.Source` on the way out — search results are untrusted.
"""
from pydantic import BaseModel, Field

from harness.sources import MAX_LISTED_SOURCES, Source


class ConversationSourcesResponse(BaseModel):
    """Bridge ← agents: the conversation's sources, newest first."""
    sources: list[Source] = Field(default_factory=list, max_length=MAX_LISTED_SOURCES)


class CopyConversationSourcesRequest(BaseModel):
    """Bridge → agents: give a fork its source conversation's sources."""
    target_conversation_id: str = Field(min_length=1, max_length=128)
