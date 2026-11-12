"""What the bridge asks of a conversation's sources: read, fork copy, delete.

Thin over :class:`~harness.sources.ConversationSourceStore`; the routes in
``router/conversation_sources.py`` only translate. The rows are written by
``SourcesMiddleware`` during runs, never through these calls.
"""
from __future__ import annotations

from harness.memory import get_memory_pool
from harness.sources import ConversationSourceStore, Source


def _store() -> ConversationSourceStore:
    return ConversationSourceStore(get_memory_pool())


async def list_conversation_sources(user_id: str, conversation_id: str) -> list[Source]:
    """The conversation's sources, newest first, at most 500."""
    return await _store().list_sources(user_id, conversation_id)


async def copy_conversation_sources(user_id: str, source_id: str, target_id: str) -> int:
    """A fork's sources: every row of the conversation it was forked from."""
    return await _store().copy_conversation(user_id, source_id, target_id)


async def delete_conversation_sources(user_id: str, conversation_id: str) -> int:
    """Delete the conversation's sources (idempotent: none left is success)."""
    return await _store().delete_conversation(user_id, conversation_id)
