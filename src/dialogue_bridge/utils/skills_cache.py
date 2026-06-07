"""Redis read-through cache for the bridge's skills endpoints.

Every cache entry carries a TTL — nothing is cached forever. The registry
key (``skills:registry``) is shared across all users. Phase 2 will add
``skills:user:<user_id>:agent:<agent_id>`` for per-(user, agent) selections;
the helpers here generalise so the same TTL + invalidation pattern applies.

The Redis client is created lazily on first use, sharing the connection
configuration that ``utils.event_log.RedisEventLog`` already uses for the
inference event stream.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, List

import redis.asyncio as aioredis

from core.settings import settings
from observability import get_logger

logger = get_logger(__name__)

# The registry only changes when the agents-service image is redeployed, so
# a long TTL is appropriate. A user-triggered refresh button in the UI sends
# ``bypass_redis=true`` which forces an upstream fetch and refreshes this
# cache, giving operators escape velocity without waiting for the TTL.
SKILLS_REGISTRY_TTL_SECONDS = 24 * 60 * 60  # 24 hours

_REGISTRY_KEY = "skills:registry"


class SkillsCache:
    """Lightweight async Redis wrapper scoped to skill-related cache keys."""

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._lock = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is None:
                password = settings.redis.password.get_secret_value() or None
                self._client = aioredis.from_url(
                    settings.redis.url,
                    password=password,
                    encoding="utf-8",
                    decode_responses=True,
                )
        return self._client

    async def get_registry(self) -> List[dict[str, Any]] | None:
        """Return the cached skills registry list, or None on miss / error.

        A None result triggers the read-through path in the caller; the
        cache layer itself never raises.
        """
        try:
            client = await self._get_client()
            raw = await client.get(_REGISTRY_KEY)
        except Exception:  # noqa: BLE001 — Redis must never break the request path
            logger.warning("skills_cache_get_failed", "Skills registry cache read failed", exc_info=True)
            return None
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("skills_cache_decode_failed", "Skills registry cache returned malformed JSON")
            return None
        return payload if isinstance(payload, list) else None

    async def set_registry(
        self, payload: List[dict[str, Any]], *, ttl_seconds: int = SKILLS_REGISTRY_TTL_SECONDS
    ) -> None:
        """Store the list in Redis with an explicit TTL — never forever."""
        try:
            client = await self._get_client()
            await client.set(_REGISTRY_KEY, json.dumps(payload, ensure_ascii=False), ex=ttl_seconds)
        except Exception:  # noqa: BLE001
            logger.warning("skills_cache_set_failed", "Skills registry cache write failed", exc_info=True)

    async def invalidate_registry(self) -> None:
        """Delete the registry cache entry (used by future mutation endpoints)."""
        try:
            client = await self._get_client()
            await client.delete(_REGISTRY_KEY)
        except Exception:  # noqa: BLE001
            logger.warning("skills_cache_invalidate_failed", "Skills registry cache delete failed", exc_info=True)


skills_cache = SkillsCache()
