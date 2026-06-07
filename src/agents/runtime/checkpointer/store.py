"""Process-level cache of LangGraph in-memory checkpointers keyed by thread_id.

The agents service runs as a single replica (see the deployment plan). Both
``/agents/{slug}/stream`` and ``/agents/{slug}/resume`` create a fresh agent
instance per request, so without a shared store the paused LangGraph
checkpoint from a HITL-interrupted stream would be lost before the resume
request can pick it back up.

This cache keeps one ``InMemorySaver`` per ``thread_id`` for the lifetime of
the process. When a run terminates without a pending interrupt the bridge can
call :func:`release_checkpointer` to free the entry; otherwise the LRU eviction
caps total memory growth.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from typing import Final

from langgraph.checkpoint.memory import InMemorySaver

# Bound to avoid unbounded growth if release_checkpointer is never called.
# A typical single-tenant install never reaches this; very high-throughput
# deployments should switch to a Postgres-backed checkpointer instead.
_MAX_ENTRIES: Final[int] = 256

_cache: "OrderedDict[str, InMemorySaver]" = OrderedDict()
_lock: asyncio.Lock = asyncio.Lock()


async def get_or_create_checkpointer(thread_id: str) -> InMemorySaver:
    """Return the cached checkpointer for ``thread_id``, creating it if absent."""
    if not thread_id:
        # No thread_id → no resume possible. Return an ephemeral saver that
        # nothing else can look up; the caller will GC it with the agent.
        return InMemorySaver()

    async with _lock:
        saver = _cache.get(thread_id)
        if saver is None:
            saver = InMemorySaver()
            _cache[thread_id] = saver
            if len(_cache) > _MAX_ENTRIES:
                # Evict the least-recently-used entry to keep memory bounded.
                _cache.popitem(last=False)
        else:
            _cache.move_to_end(thread_id)
        return saver


async def release_checkpointer(thread_id: str) -> None:
    """Drop the cached checkpointer for ``thread_id`` (call after terminal status)."""
    if not thread_id:
        return
    async with _lock:
        _cache.pop(thread_id, None)


async def has_checkpointer(thread_id: str) -> bool:
    """Cheap probe used by the resume endpoint to fail fast on unknown threads."""
    if not thread_id:
        return False
    async with _lock:
        return thread_id in _cache
