"""The per-conversation lock a manual compaction holds (plan 34).

While a compaction summarizes a branch (seconds), no run may start on the same
conversation: the run would build on the state the compaction is about to
replace. The compaction takes this Redis lock first; run creation refuses while
it is held. The lock is the first line only — the agents service also refuses
to write when the branch's head moved, so even a run that slipped past the
check can never be overwritten.

A separate module from :mod:`utils.compaction` because run creation imports it,
and compaction imports the run module's status constants.
"""
from __future__ import annotations

import asyncio

from redis import asyncio as aioredis
from redis.exceptions import RedisError

from core.cache import create_redis_client
from core.logging import get_logger

logger = get_logger(__name__)

#: Longer than any compaction can take (the agents call is bounded at 240 s), so
#: a crashed holder never blocks the conversation for good.
LOCK_TTL_SECONDS = 300


def _key(conversation_id: str) -> str:
    return f"compaction:{conversation_id}"


class CompactionLocks:
    """SET NX locks keyed by conversation, on one lazily created client."""

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._guard = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._guard:
            if self._client is None:
                self._client = create_redis_client()
        return self._client

    async def acquire(self, conversation_id: str) -> bool:
        """Take the lock; False when another compaction holds it. Redis errors
        propagate — a compaction must not run without its lock."""
        client = await self._get_client()
        return bool(await client.set(_key(conversation_id), "1", nx=True, ex=LOCK_TTL_SECONDS))

    async def release(self, conversation_id: str) -> None:
        """Drop the lock (best effort — it expires on its own anyway)."""
        try:
            client = await self._get_client()
            await client.delete(_key(conversation_id))
        except RedisError:
            logger.warning("compaction_lock_release_failed", "Could not release a compaction lock", exc_info=True)

    async def held(self, conversation_id: str) -> bool:
        """Whether a compaction is running on the conversation.

        A Redis error answers False rather than blocking every run: a run cannot
        stream without Redis anyway, and the agents' head check still protects
        the branch.
        """
        try:
            client = await self._get_client()
            return bool(await client.exists(_key(conversation_id)))
        except RedisError:
            logger.warning("compaction_lock_probe_failed", "Could not read a compaction lock", exc_info=True)
            return False


compaction_locks = CompactionLocks()
