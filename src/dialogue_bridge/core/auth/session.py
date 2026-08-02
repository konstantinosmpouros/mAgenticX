from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import redis.asyncio as aioredis
from fastapi import Depends, HTTPException, Request, Response, status
from observability import get_logger, set_context

from core.cache import create_redis_client
from core.settings import settings
from core.auth.tokens import (
    ACCESS_TYPE,
    REFRESH_TYPE,
    IssuedTokens,
    TokenError,
    mint_tokens,
    verify as verify_token,
)

logger = get_logger(__name__)


_LOGOUT_KEY_PREFIX = "auth:logout:sid:"


class LogoutDenylist:
    """Redis-backed instant-logout list keyed by session id (``sid``).

    Stateless auth verifies a JWT by signature alone, so to make logout — and a
    stolen-token replay after logout — take effect immediately we record the
    logged-out ``sid`` here until the token would expire on its own. The list is
    empty in the normal case; it is shared infra (Redis), so it never logs anyone
    out when a request lands on a different VM. Both operations fail SAFE:
    ``is_revoked`` fails OPEN (Redis down → request still served on a valid
    signature) and ``revoke`` is best-effort (logout already cleared the cookies).
    """

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._lock = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is None:
                self._client = create_redis_client()
        return self._client

    async def revoke(self, sid: str, ttl_seconds: int) -> None:
        if not sid or ttl_seconds <= 0:
            return
        try:
            client = await self._get_client()
            await client.setex(f"{_LOGOUT_KEY_PREFIX}{sid}", ttl_seconds, "1")
        except Exception:
            logger.warning(
                "logout_denylist_write_failed",
                "Could not record logout in the denylist; cookies were still cleared",
            )

    async def is_revoked(self, sid: str) -> bool:
        if not sid:
            return False
        try:
            client = await self._get_client()
            return bool(await client.exists(f"{_LOGOUT_KEY_PREFIX}{sid}"))
        except Exception:
            logger.warning(
                "logout_denylist_unavailable",
                "Logout denylist check failed; allowing the request (fail-open)",
            )
            return False


logout_denylist = LogoutDenylist()


_REFRESH_CUR_PREFIX = "auth:refresh:cur:sid:"
_REFRESH_USED_PREFIX = "auth:refresh:used:"


class RefreshTokenGuard:
    """Redis-backed refresh-token rotation + reuse detection.

    Every refresh rotates the refresh token (new ``jti``); this tracks the single
    currently-valid ``jti`` per session id (``sid``). Presenting an OLD refresh
    ``jti`` — one already rotated away and past the grace window — means the token
    was replayed (e.g. a stolen copy used after the legitimate client refreshed),
    so the caller denylists the whole ``sid`` and kills the session. A short grace
    window keeps the just-rotated-from ``jti`` valid briefly, so a legitimate
    concurrent/retried refresh is never misread as reuse. Every operation fails
    OPEN on a Redis error (same stance as the logout denylist) — it degrades to
    "no reuse detection", never to a lockout.
    """

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._lock = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is None:
                self._client = create_redis_client()
        return self._client

    async def register(self, sid: str, jti: str, ttl_seconds: int) -> None:
        """Record ``jti`` as the current valid refresh token for ``sid`` (at login)."""
        if not sid or not jti or ttl_seconds <= 0:
            return
        try:
            client = await self._get_client()
            await client.setex(f"{_REFRESH_CUR_PREFIX}{sid}", ttl_seconds, jti)
        except Exception:
            logger.warning("refresh_guard_register_failed", "Could not record refresh jti (fail-open)")

    async def status(self, sid: str, presented_jti: str | None) -> str:
        """Classify a presented refresh jti: ``ok`` | ``reuse`` | ``unknown`` (fail-open)."""
        if not sid or not presented_jti:
            return "unknown"
        try:
            client = await self._get_client()
            current = await client.get(f"{_REFRESH_CUR_PREFIX}{sid}")
            if current is None:
                # No record (first refresh after deploy, key TTL-expired, or Redis
                # was flushed). Cannot prove reuse → fail open.
                return "unknown"
            if presented_jti == current:
                return "ok"
            if await client.exists(f"{_REFRESH_USED_PREFIX}{sid}:{presented_jti}"):
                # Just-rotated-from jti inside the grace window → legitimate
                # concurrent/retried refresh, not a replay.
                return "ok"
            return "reuse"
        except Exception:
            logger.warning("refresh_guard_status_unavailable", "Refresh reuse check failed; allowing (fail-open)")
            return "unknown"

    async def rotate(
        self, sid: str, old_jti: str | None, new_jti: str, ttl_seconds: int, grace_seconds: int
    ) -> None:
        """Advance the current jti to ``new_jti``; grace the ``old_jti`` briefly."""
        if not sid or not new_jti or ttl_seconds <= 0:
            return
        try:
            client = await self._get_client()
            if old_jti and grace_seconds > 0:
                await client.setex(f"{_REFRESH_USED_PREFIX}{sid}:{old_jti}", grace_seconds, "1")
            await client.setex(f"{_REFRESH_CUR_PREFIX}{sid}", ttl_seconds, new_jti)
        except Exception:
            logger.warning("refresh_guard_rotate_failed", "Could not rotate refresh jti (fail-open)")


refresh_guard = RefreshTokenGuard()

SESSION_COOKIE_SECURE = settings.session.secure
SESSION_COOKIE_SAMESITE = settings.session.samesite
SESSION_COOKIE_DOMAIN = settings.session.domain
SESSION_ACCESS_COOKIE_NAME = settings.session.access_cookie_name
SESSION_REFRESH_COOKIE_NAME = settings.session.refresh_cookie_name
CSRF_COOKIE_NAME = settings.session.csrf_cookie_name
CSRF_HEADER_NAME = settings.session.csrf_header_name


class SessionAuthenticationError(Exception):
    """Raised when a session token cannot be validated."""


@dataclass(slots=True)
class AuthContext:
    """Identity resolved from a verified access/refresh JWT — no DB row.

    ``id`` is the login session id (``sid``): stable across refresh for one
    device login and the key used by the instant-logout denylist.
    """

    id: str
    user_id: str
    is_active: bool
    expires_at: datetime
    login_at: Optional[int] = None
    jti: Optional[str] = None


@dataclass(slots=True)
class AuthUser:
    """Lightweight authenticated user derived from JWT claims (no DB load)."""

    id: str
    is_active: bool


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _claim_expiry(exp: int) -> datetime:
    return datetime.fromtimestamp(exp, tz=timezone.utc).replace(tzinfo=None)


def build_auth_response(user, ttl_seconds: int) -> dict:
    return {
        "authenticated": True,
        "user_id": user.id,
        "user": user,
        "tokenTtl": ttl_seconds,
    }


def _cookie_domain() -> str | None:
    if SESSION_ACCESS_COOKIE_NAME.startswith("__Host-"):
        return None
    return SESSION_COOKIE_DOMAIN


def issue_session_cookies(response: Response, issued: IssuedTokens) -> None:
    cookie_domain = _cookie_domain()
    response.set_cookie(
        key=SESSION_ACCESS_COOKIE_NAME,
        value=issued.access_token,
        max_age=issued.access_ttl,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=cookie_domain,
        path="/",
    )
    response.set_cookie(
        key=SESSION_REFRESH_COOKIE_NAME,
        value=issued.refresh_token,
        max_age=issued.refresh_ttl,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=cookie_domain,
        path="/",
    )
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=issued.csrf_token,
        max_age=issued.refresh_ttl,
        httponly=False,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=cookie_domain,
        path="/",
    )


def clear_session_cookies(response: Response) -> None:
    cookie_domain = _cookie_domain()
    for key in (SESSION_ACCESS_COOKIE_NAME, SESSION_REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME):
        response.delete_cookie(key=key, path="/", domain=cookie_domain)


def _parse_bearer_token(request: Request) -> Optional[str]:
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        return None
    try:
        scheme, token = auth_header.split(" ", 1)
    except ValueError:
        return None
    if scheme.lower() != "bearer":
        return None
    return token.strip() or None


def _get_access_token_from_request(request: Request) -> Optional[str]:
    bearer = _parse_bearer_token(request)
    if bearer:
        return bearer
    cookie_token = request.cookies.get(SESSION_ACCESS_COOKIE_NAME)
    return cookie_token.strip() if cookie_token else None


def _get_refresh_token_from_request(request: Request) -> Optional[str]:
    token = request.cookies.get(SESSION_REFRESH_COOKIE_NAME)
    return token.strip() if token else None


async def mint_login_session(user) -> IssuedTokens:
    """Mint a brand-new session (fresh sid) for a freshly authenticated user."""
    return await mint_tokens(user.id, is_active=user.is_active)


async def rotate_session(ctx: AuthContext, *, is_active: bool = True) -> IssuedTokens:
    """Rotate the access + refresh pair, preserving the original sid and login_at
    so the denylist still covers this login and the 10-day refresh cap doesn't slide."""
    return await mint_tokens(ctx.user_id, sid=ctx.id, login_at=ctx.login_at, is_active=is_active)


async def _resolve(request: Request, token: str | None, expected_type: str) -> AuthContext:
    if not token:
        raise SessionAuthenticationError("Missing token.")
    try:
        claims = await verify_token(token, expected_type)
    except TokenError as exc:
        raise SessionAuthenticationError(str(exc)) from exc
    sid = claims["sid"]
    if await logout_denylist.is_revoked(sid):
        raise SessionAuthenticationError("Session has been logged out.")
    is_active = bool(claims.get("act", True))
    if expected_type == ACCESS_TYPE and not is_active:
        raise SessionAuthenticationError("User is inactive.")
    return AuthContext(
        id=sid,
        user_id=claims["sub"],
        is_active=is_active,
        expires_at=_claim_expiry(int(claims["exp"])),
        login_at=claims.get("lat"),
        jti=claims.get("jti"),
    )


def access_ttl_for_session(ctx: AuthContext) -> int:
    return max(0, int((ctx.expires_at - utcnow()).total_seconds()))


async def require_session(request: Request) -> AuthContext:
    try:
        ctx = await _resolve(request, _get_access_token_from_request(request), ACCESS_TYPE)
    except SessionAuthenticationError as exc:
        logger.warning("access_session_invalid", "Access session validation failed", error=str(exc), failure_reason="access_session_invalid")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.") from exc

    set_context(user_id=ctx.user_id, session_id=ctx.id)
    # Shared with the request-logging middleware (contextvars set here don't
    # propagate back to it under Starlette), so the access log line carries the
    # same session/user as the business logs.
    request.state.session_id = ctx.id
    request.state.user_id = ctx.user_id
    return ctx


async def require_current_user(ctx: AuthContext = Depends(require_session)) -> AuthUser:
    return AuthUser(id=ctx.user_id, is_active=ctx.is_active)


async def require_bound_user_id(
    user_id: str,
    current_user: AuthUser = Depends(require_current_user),
) -> AuthUser:
    if user_id != current_user.id:
        logger.warning("user_scope_mismatch", "Authenticated user attempted to access another user scope", requested_user_id=user_id, authenticated_user_id=current_user.id)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token does not grant access to this user.",
        )
    return current_user


async def require_refresh_session(request: Request) -> AuthContext:
    try:
        ctx = await _resolve(request, _get_refresh_token_from_request(request), REFRESH_TYPE)
    except SessionAuthenticationError as exc:
        logger.warning("refresh_session_invalid", "Refresh session validation failed", error=str(exc), failure_reason="refresh_session_invalid")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.") from exc

    set_context(user_id=ctx.user_id, session_id=ctx.id)
    request.state.session_id = ctx.id
    request.state.user_id = ctx.user_id
    return ctx


async def revoke_current_session(request: Request) -> str | None:
    """Instant logout: read the caller's access (or refresh) token, and denylist
    its sid for the full refresh lifetime so neither token survives — including a
    copy exfiltrated before logout. Best-effort; returns the sid or None."""
    for getter, token_type in (
        (_get_access_token_from_request, ACCESS_TYPE),
        (_get_refresh_token_from_request, REFRESH_TYPE),
    ):
        token = getter(request)
        if not token:
            continue
        try:
            claims = await verify_token(token, token_type)
        except TokenError:
            continue
        sid = claims.get("sid")
        if not sid:
            continue
        set_context(user_id=claims.get("sub"), session_id=sid)
        # Cover the maximum session lifetime — the denylist entry auto-expires.
        await logout_denylist.revoke(sid, settings.jwt.refresh_absolute_ttl_seconds)
        return sid
    return None


async def authenticate_websocket_user(
    websocket_cookies: dict[str, str] | object,
    user_id: str,
) -> AuthUser | None:
    """Validate a WebSocket connection's access JWT cookie and user binding.

    Returns the bound :class:`AuthUser` on success or ``None`` on any failure.
    Unlike the REST dependency chain this does NOT raise — the caller emits a
    clean close frame with a descriptive code.
    """
    cookies_get = getattr(websocket_cookies, "get", None)
    if cookies_get is None:
        return None
    token = (cookies_get(SESSION_ACCESS_COOKIE_NAME) or "").strip()
    if not token:
        return None
    try:
        claims = await verify_token(token, ACCESS_TYPE)
    except TokenError:
        return None
    sid = claims.get("sid")
    if not sid or await logout_denylist.is_revoked(sid):
        return None
    if not claims.get("act", True):
        return None
    if claims.get("sub") != user_id:
        logger.warning(
            "ws_user_scope_mismatch",
            "WebSocket caller attempted to access another user scope",
            requested_user_id=user_id,
            authenticated_user_id=claims.get("sub"),
        )
        return None
    set_context(user_id=claims["sub"], session_id=sid)
    return AuthUser(id=claims["sub"], is_active=bool(claims.get("act", True)))


async def require_csrf_protection(request: Request) -> None:
    if request.method.upper() in {"GET", "HEAD", "OPTIONS"}:
        return

    # Bearer-only clients are not vulnerable to browser CSRF.
    bearer = _parse_bearer_token(request)
    cookie_access = request.cookies.get(SESSION_ACCESS_COOKIE_NAME)
    if bearer and not cookie_access:
        return

    header_value = request.headers.get(CSRF_HEADER_NAME)
    cookie_value = request.cookies.get(CSRF_COOKIE_NAME)
    if not header_value or not cookie_value or not secrets.compare_digest(header_value, cookie_value):
        logger.warning("csrf_validation_failed", "CSRF validation failed", failure_reason="csrf_mismatch")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid CSRF token.",
        )
