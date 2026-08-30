"""Redis read-through cache for the bridge's skills endpoints.

Domain wrapper over the SDK-backed imperative cache
(``core.cache.policies.get_cache_backend`` → ``redis_fastapi.CacheBackend``).
The backend owns serialization (JSON coder), key prefixing, and fail-open
error handling — every operation degrades to a miss/no-op on a Redis outage,
so the cache can never break a request. This module owns only the *skills*
semantics: which key families exist, their TTLs, and when they are evicted.

Every cache entry carries a TTL — nothing is cached forever. All three TTLs
are driven from ``settings.redis`` (core/settings.py) and tunable per
environment. Three key families live here (names + groups defined in
``core.cache.policies`` so writers and evictors can never drift):

- ``skills:global`` — the admin-curated catalog, shared across all users
  (``skills_global_ttl_seconds``, default 24 h; refreshed by the UI's
  bypass-Redis path).
- ``skills:user:<user_id>:registry`` — the user's personal skill pool
  manifest (``skills_user_registry_ttl_seconds``, default 2 h; invalidated
  by every pool mutation).
- ``skills:user:<user_id>:agent:<agent_id>`` — the per-(user, agent)
  assignment set (``skills_user_agent_ttl_seconds``, default 2 h). Each entry
  joins the per-user eviction group ``skills:agents:<user_id>``, so the
  cascade on pool deletion is a single ``delete_group`` instead of the old
  hand-rolled SCAN loop.
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

    # ------------------------------------------------------------------
    # Per-user registry pool
    # ------------------------------------------------------------------

skills_cache = SkillsCache()
