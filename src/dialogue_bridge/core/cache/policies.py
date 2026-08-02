"""Cache policy registry: the names, TTLs, and eviction groups the bridge uses.

One module owns every cache key family and its invalidation group so the two
can never drift — whoever writes an entry joins the same group the eviction
path clears. Consumers get an imperative :class:`redis_fastapi.CacheBackend`
from :func:`get_cache_backend`, built over the shared client factory
(``core.cache.client``) so TLS trust and credentials match every other Redis
connection in the service.

Current families (the skills read-through cache — see ``utils.skills_cache``
for the domain-level wrapper):

- ``skills:global``                         — admin-curated catalog, all users
- ``skills:user:{user_id}:registry``        — one user's personal skill pool
- ``skills:user:{user_id}:agent:{agent_id}``— one (user, agent) selection set,
  joined to the per-user group below so pool deletions cascade in one
  ``delete_group`` instead of a hand-rolled SCAN loop.
"""
from __future__ import annotations

import asyncio

from redis_fastapi import CacheBackend

from core.cache.client import create_redis_client

# --- Skills cache key families -------------------------------------------

SKILLS_GLOBAL_KEY = "skills:global"


def skills_user_registry_key(user_id: str) -> str:
    """Cache key for one user's skill pool manifest."""
    return f"skills:user:{user_id}:registry"


def skills_user_agent_key(user_id: str, agent_id: str) -> str:
    """Cache key for one (user, agent) enabled-skill selection set."""
    return f"skills:user:{user_id}:agent:{agent_id}"


def skills_user_agent_group(user_id: str) -> str:
    """Eviction group joining every per-(user, agent) selection entry.

    Deleting a skill from the user's pool cascade-invalidates all of them via
    ``delete_group`` on this name.
    """
    return f"skills:agents:{user_id}"


# --- Shared imperative backend --------------------------------------------

_backend: CacheBackend | None = None
_backend_lock = asyncio.Lock()


async def get_cache_backend() -> CacheBackend:
    """Process-wide imperative cache backend, created lazily on first use.

    Lazy (not module-import time) so constructing the Redis client happens
    once an event loop exists, mirroring the other lazy consumers of the
    shared factory. JSON coding is the backend default, matching what the
    hand-rolled cache stored before the migration.
    """
    global _backend
    if _backend is not None:
        return _backend
    async with _backend_lock:
        if _backend is None:
            _backend = CacheBackend(create_redis_client())
    return _backend
