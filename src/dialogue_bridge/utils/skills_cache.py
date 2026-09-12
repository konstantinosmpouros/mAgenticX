"""Redis read-through cache for the bridge's skills endpoints.

Domain wrapper over the SDK-backed imperative cache
(``core.cache.policies.get_cache_backend`` → ``redis_fastapi.CacheBackend``).
The backend owns serialization (JSON coder), key prefixing, and fail-open
error handling — every operation degrades to a miss/no-op on a Redis outage,
so the cache can never break a request. This module owns only the *skills*
semantics: which key families exist, their TTLs, and when they are evicted.

**One key family, deliberately.** ``skills:global`` holds the admin-curated
catalog — shared by every user, changed only by an admin editing the volume, and
expensive to rebuild — so caching it is worth a TTL
(``skills_global_ttl_seconds``, default 24 h; the UI's bypass path refreshes it
for everyone).

The per-user families that used to live here are gone. A user's pool and their
per-agent assignments are written by an **agent** mid-run, with no event telling
the bridge it happened, so a TTL meant serving a skill list that was already
wrong — a tool-created skill stayed invisible for up to two hours. Those reads
are plain queries now; correctness beat one saved round-trip.
"""
from __future__ import annotations

from typing import Any, List

from core.cache.policies import (
    SKILLS_GLOBAL_KEY,
    get_cache_backend,
)
from core.settings import settings
from core.logging import get_logger

logger = get_logger(__name__)


class SkillsCache:
    """Skills-scoped cache operations over the shared SDK backend."""

    # ------------------------------------------------------------------
    # Global catalog
    # ------------------------------------------------------------------
    async def get_global(self) -> List[dict[str, Any]] | None:
        """Return the cached global skills catalog, or None on miss / error.

        A None result triggers the read-through path in the caller. Shape is
        validated because cached content is only semi-trusted (an old deploy
        could have stored something else under the same key).
        """
        backend = await get_cache_backend()
        payload = await backend.get(SKILLS_GLOBAL_KEY)
        return payload if isinstance(payload, list) else None

    async def set_global(
        self, payload: List[dict[str, Any]], *, ttl_seconds: int = settings.redis.skills_global_ttl_seconds
    ) -> None:
        """Store the global catalog with an explicit TTL — never forever."""
        backend = await get_cache_backend()
        await backend.set(SKILLS_GLOBAL_KEY, payload, ttl=ttl_seconds)

    async def invalidate_global(self) -> None:
        """Delete the global catalog cache entry."""
        backend = await get_cache_backend()
        await backend.delete(SKILLS_GLOBAL_KEY)

skills_cache = SkillsCache()
