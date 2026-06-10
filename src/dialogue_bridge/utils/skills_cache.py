"""Redis read-through cache for the bridge's skills endpoints.

Every cache entry carries a TTL — nothing is cached forever. All three TTLs
are driven from ``settings.redis`` (core/settings.py) and tunable per
environment. Three key families live here:

- ``skills:global`` — the admin-curated catalog, shared across all users
  (``skills_global_ttl_seconds``, default 24 h; refreshed by the UI's
  bypass-Redis path).
- ``skills:user:<user_id>:registry`` — the user's personal skill pool
  manifest (``skills_user_registry_ttl_seconds``, default 2 h; invalidated
  by every pool mutation).
- ``skills:user:<user_id>:agent:<agent_id>`` — the per-(user, agent)
  assignment set (``skills_user_agent_ttl_seconds``, default 2 h;
  invalidated by assignment mutations + cascade on pool delete).

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

# Every cache TTL is driven from ``settings.redis`` (see core/settings.py) so
# operators can tune cache freshness per environment without a code change:
#   - global catalog      → settings.redis.skills_global_ttl_seconds
#   - user pool registry  → settings.redis.skills_user_registry_ttl_seconds
#   - per-(user, agent)   → settings.redis.skills_user_agent_ttl_seconds
# Mutations evict the matching key explicitly, so each TTL is a freshness
# safety net rather than the primary invalidation mechanism.

_GLOBAL_KEY = "skills:global"


def _user_registry_key(user_id: str) -> str:
    """Namespaced cache key for one user's skill pool manifest."""
    return f"skills:user:{user_id}:registry"


def _user_agent_key(user_id: str, agent_id: str) -> str:
    """Namespaced cache key for one (user, agent) selection set."""
    return f"skills:user:{user_id}:agent:{agent_id}"


def _user_agent_key_pattern(user_id: str) -> str:
    """Glob pattern matching every per-(user, agent) cache key for this user.

    Used by the cascade on user-pool deletion — when a skill is removed
    from the user's pool, the agents service also cleans up every per-agent
    assignment, so we drop every cached selection set for the user.
    """
    return f"skills:user:{user_id}:agent:*"


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

    async def get_global(self) -> List[dict[str, Any]] | None:
        """Return the cached global skills catalog, or None on miss / error.

        A None result triggers the read-through path in the caller; the
        cache layer itself never raises.
        """
        try:
            client = await self._get_client()
            raw = await client.get(_GLOBAL_KEY)
        except Exception:  # noqa: BLE001 — Redis must never break the request path
            logger.warning("skills_global_cache_get_failed", "Global skills cache read failed", exc_info=True)
            return None
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("skills_global_cache_decode_failed", "Global skills cache returned malformed JSON")
            return None
        return payload if isinstance(payload, list) else None

    async def set_global(
        self, payload: List[dict[str, Any]], *, ttl_seconds: int = settings.redis.skills_global_ttl_seconds
    ) -> None:
        """Store the global catalog in Redis with an explicit TTL — never forever."""
        try:
            client = await self._get_client()
            await client.set(_GLOBAL_KEY, json.dumps(payload, ensure_ascii=False), ex=ttl_seconds)
        except Exception:  # noqa: BLE001
            logger.warning("skills_global_cache_set_failed", "Global skills cache write failed", exc_info=True)

    async def invalidate_global(self) -> None:
        """Delete the global catalog cache entry."""
        try:
            client = await self._get_client()
            await client.delete(_GLOBAL_KEY)
        except Exception:  # noqa: BLE001
            logger.warning("skills_global_cache_invalidate_failed", "Global skills cache delete failed", exc_info=True)

    # ------------------------------------------------------------------
    # Per-user registry pool
    # ------------------------------------------------------------------
    async def get_user_registry(self, user_id: str) -> List[dict[str, Any]] | None:
        """Return the cached user pool manifest entries, or None on miss / error."""
        try:
            client = await self._get_client()
            raw = await client.get(_user_registry_key(user_id))
        except Exception:  # noqa: BLE001
            logger.warning(
                "user_registry_cache_get_failed",
                "User registry cache read failed",
                exc_info=True,
            )
            return None
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(
                "user_registry_cache_decode_failed",
                "User registry cache returned malformed JSON",
            )
            return None
        return payload if isinstance(payload, list) else None

    async def set_user_registry(
        self,
        user_id: str,
        payload: List[dict[str, Any]],
        *,
        ttl_seconds: int = settings.redis.skills_user_registry_ttl_seconds,
    ) -> None:
        """Store the user pool manifest in Redis with a settings-driven TTL."""
        try:
            client = await self._get_client()
            await client.set(
                _user_registry_key(user_id),
                json.dumps(payload, ensure_ascii=False),
                ex=ttl_seconds,
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "user_registry_cache_set_failed",
                "User registry cache write failed",
                exc_info=True,
            )

    async def invalidate_user_registry(self, user_id: str) -> None:
        """Drop the user pool cache (call on every mutation to the pool)."""
        try:
            client = await self._get_client()
            await client.delete(_user_registry_key(user_id))
        except Exception:  # noqa: BLE001
            logger.warning(
                "user_registry_cache_invalidate_failed",
                "User registry cache delete failed",
                exc_info=True,
            )

    async def invalidate_all_user_agent_keys(self, user_id: str) -> None:
        """Drop every per-(user, agent) cache key for this user.

        Called when the user removes a skill from their pool — the agents
        service cascade-removes the skill from every per-agent assignment
        folder, so caller-side every per-agent cached selection set is
        potentially stale.
        """
        try:
            client = await self._get_client()
            pattern = _user_agent_key_pattern(user_id)
            cursor = 0
            deleted = 0
            while True:
                cursor, keys = await client.scan(cursor=cursor, match=pattern, count=200)
                if keys:
                    deleted += await client.delete(*keys)
                if cursor == 0:
                    break
            if deleted:
                logger.info(
                    "user_agent_keys_cascade_invalidated",
                    "Cascaded user-agent cache invalidation",
                    user_id=user_id,
                    deleted=deleted,
                )
        except Exception:  # noqa: BLE001
            logger.warning(
                "user_agent_keys_cascade_failed",
                "Cascade invalidation of user-agent keys failed",
                exc_info=True,
            )

    async def get_user_agent_skills(self, user_id: str, agent_id: str) -> List[str] | None:
        """Return the cached enabled-skill names for a (user, agent) pair."""
        try:
            client = await self._get_client()
            raw = await client.get(_user_agent_key(user_id, agent_id))
        except Exception:  # noqa: BLE001
            logger.warning(
                "user_agent_skills_cache_get_failed",
                "User-agent skills cache read failed",
                exc_info=True,
            )
            return None
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(
                "user_agent_skills_cache_decode_failed",
                "User-agent skills cache returned malformed JSON",
            )
            return None
        if not isinstance(payload, list):
            return None
        return [str(item) for item in payload]

    async def set_user_agent_skills(
        self,
        user_id: str,
        agent_id: str,
        payload: List[str],
        *,
        ttl_seconds: int = settings.redis.skills_user_agent_ttl_seconds,
    ) -> None:
        """Store the enabled-skill names with a settings-driven TTL — never forever."""
        try:
            client = await self._get_client()
            await client.set(
                _user_agent_key(user_id, agent_id),
                json.dumps(payload, ensure_ascii=False),
                ex=ttl_seconds,
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "user_agent_skills_cache_set_failed",
                "User-agent skills cache write failed",
                exc_info=True,
            )

    async def invalidate_user_agent_skills(self, user_id: str, agent_id: str) -> None:
        """Delete the cached enabled-skill names for a (user, agent) pair."""
        try:
            client = await self._get_client()
            await client.delete(_user_agent_key(user_id, agent_id))
        except Exception:  # noqa: BLE001
            logger.warning(
                "user_agent_skills_cache_invalidate_failed",
                "User-agent skills cache delete failed",
                exc_info=True,
            )


skills_cache = SkillsCache()
