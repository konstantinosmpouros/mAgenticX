"""App-level per-user request rate limiting for the whole backend.

A single Starlette middleware caps how many API calls one identity may make per
fixed window across *every* endpoint (default 300/min) — one aggregate budget
per user, not a per-route limit. The identity is the authenticated user id taken
from the **verified** session JWT, so a user gets the same bucket no matter which
endpoints they hit and the key cannot be forged onto someone else. Requests with
no valid session (e.g. login/refresh before a session exists) fall back to a
per-client-IP bucket. Counting lives in **Redis** so the limit holds across
replicas.

`/health` and the internal service-to-service routes (`/v1/internal/*`) are
exempt — the former is the container probe, the latter is already gated by
`require_internal_caller` and legitimately bursts past a human budget from one
source. If Redis is unreachable the middleware fails **open** (serves the
request): a rate limiter must never take the whole API down — the same
availability-first stance as the logout denylist.
"""
from __future__ import annotations

import time

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from core.auth.tokens import ACCESS_TYPE, verify
from core.redis import create_redis_client
from core.security.internal_trust import resolve_client_ip
from core.settings import settings
from observability.events import get_logger

logger = get_logger("dialogue_bridge.rate_limit")

_EXEMPT_PATHS = frozenset({"/health"})
_EXEMPT_PREFIXES = ("/v1/internal",)


class UserRateLimitMiddleware(BaseHTTPMiddleware):
    """Per-user (per-IP fallback) fixed-window API rate limit, Redis-backed."""

    def __init__(self, app) -> None:
        super().__init__(app)
        # One shared client for the app's lifetime; aioredis pools connections
        # and connects lazily, so building it here (before the loop runs) is safe.
        self._redis = create_redis_client()
        self._max_calls = settings.rate_limit.user_max_calls
        self._window = settings.rate_limit.user_window_seconds

    async def dispatch(self, request: Request, call_next):
        if self._is_exempt(request.url.path):
            return await call_next(request)

        identity = await self._identity(request)
        if not await self._within_limit(identity):
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Please slow down and retry shortly."},
                headers={"Retry-After": str(self._window)},
            )
        return await call_next(request)

    @staticmethod
    def _is_exempt(path: str) -> bool:
        return path in _EXEMPT_PATHS or path.startswith(_EXEMPT_PREFIXES)

    async def _identity(self, request: Request) -> str:
        """Verified user id when the session cookie checks out, else client IP.

        This is the *same* verification the auth dependency runs (RS256 against
        the in-process-cached Vault key — no Vault round-trip on the hot path),
        so the bucket key can't be forged onto another user. Any failure (no
        cookie, expired, tampered) falls back to the IP bucket; the request then
        proceeds to normal auth, which rejects it there if it is actually invalid.
        """
        token = request.cookies.get(settings.session.access_cookie_name)
        if token:
            try:
                claims = await verify(token, ACCESS_TYPE)
                return f"user:{claims['sub']}"
            except Exception:
                # Any verification failure → treat as unauthenticated for keying.
                pass
        return f"ip:{resolve_client_ip(request) or 'unknown'}"

    async def _within_limit(self, identity: str) -> bool:
        """Fixed-window counter in Redis; fails OPEN if Redis is unreachable."""
        window = int(time.time()) // self._window
        key = f"ratelimit:{identity}:{window}"
        try:
            count = await self._redis.incr(key)
            if count == 1:
                # First hit this window — set a TTL so the bucket self-expires.
                # Padded past the window so a key created at the tail still clears.
                await self._redis.expire(key, self._window * 2)
            return count <= self._max_calls
        except Exception:
            logger.warning(
                "rate_limit_backend_unavailable",
                "Redis unavailable for rate limiting; failing open",
            )
            return True
