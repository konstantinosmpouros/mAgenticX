import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, Response, status
from observability import get_logger, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.configs import settings
from core.database import SessionTable, UserTable, get_db
from core.proxy import resolve_client_ip

logger = get_logger(__name__)

SESSION_COOKIE_SECURE = settings.session.secure
SESSION_COOKIE_SAMESITE = settings.session.samesite
SESSION_COOKIE_DOMAIN = settings.session.domain
SESSION_ACCESS_COOKIE_NAME = settings.session.access_cookie_name
SESSION_REFRESH_COOKIE_NAME = settings.session.refresh_cookie_name
CSRF_COOKIE_NAME = settings.session.csrf_cookie_name
CSRF_HEADER_NAME = settings.session.csrf_header_name

ACCESS_TTL_SECONDS = settings.session.access_ttl_seconds
REFRESH_TTL_SECONDS = settings.session.refresh_ttl_seconds
SESSION_MAX_PER_USER = settings.session.max_per_user

_TOKEN_SECRET = settings.session.token_secret


class SessionAuthenticationError(Exception):
    """Raised when a session token cannot be validated."""


@dataclass(slots=True)
class IssuedSession:
    session_id: str
    access_token: str
    refresh_token: str
    csrf_token: str
    access_ttl: int
    refresh_ttl: int


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _hash_token(token: str) -> str:
    digest = hmac.new(_TOKEN_SECRET.encode("utf-8"), token.encode("utf-8"), hashlib.sha256)
    return digest.hexdigest()


def _hash_optional_metadata(value: str | None) -> str | None:
    if not value:
        return None
    return hmac.new(_TOKEN_SECRET.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def _extract_client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    return resolve_client_ip(request)


def _cookie_domain() -> str | None:
    if SESSION_ACCESS_COOKIE_NAME.startswith("__Host-"):
        return None
    return SESSION_COOKIE_DOMAIN


def build_auth_response(user: UserTable, ttl_seconds: int) -> dict:
    return {
        "authenticated": True,
        "user_id": user.id,
        "user": user,
        "tokenTtl": ttl_seconds,
    }


def issue_session_cookies(response: Response, issued: IssuedSession) -> None:
    cookie_domain = _cookie_domain()
    response.set_cookie(
        key=SESSION_ACCESS_COOKIE_NAME,
        value=issued.access_token,
        max_age=issued.access_ttl,
        expires=issued.access_ttl,
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
        expires=issued.refresh_ttl,
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
        expires=issued.refresh_ttl,
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


async def _enforce_session_limit(db: AsyncSession, user_id: str) -> None:
    now = utcnow()
    stmt = (
        select(SessionTable)
        .where(
            SessionTable.user_id == user_id,
            SessionTable.revoked_at.is_(None),
            SessionTable.refresh_expires_at > now,
        )
        .order_by(SessionTable.created_at.asc())
    )
    result = await db.execute(stmt)
    active_sessions = result.scalars().all()

    overflow = len(active_sessions) - SESSION_MAX_PER_USER + 1  # +1 to make room for the new one
    if overflow > 0:
        revoked_sessions = active_sessions[:overflow]
        for session in revoked_sessions:
            session.revoked_at = now
        logger.info("session_limit_enforced", "Session limit enforced by revoking older sessions", user_id=user_id, revoked_sessions=len(revoked_sessions), session_limit=SESSION_MAX_PER_USER)


async def create_user_session(
    db: AsyncSession,
    user: UserTable,
    request: Request | None = None,
) -> IssuedSession:
    await _enforce_session_limit(db, user.id)

    access_token = secrets.token_urlsafe(48)
    refresh_token = secrets.token_urlsafe(64)
    csrf_token = secrets.token_urlsafe(32)
    now = utcnow()

    session = SessionTable(
        user_id=user.id,
        access_token_hash=_hash_token(access_token),
        refresh_token_hash=_hash_token(refresh_token),
        access_expires_at=now + timedelta(seconds=ACCESS_TTL_SECONDS),
        refresh_expires_at=now + timedelta(seconds=REFRESH_TTL_SECONDS),
        user_agent_hash=_hash_optional_metadata(request.headers.get("user-agent") if request else None),
        ip_hash=_hash_optional_metadata(_extract_client_ip(request)),
        last_used_at=now,
        last_refreshed_at=now,
    )
    db.add(session)
    await db.commit()
    logger.info("session_created", "User session created", user_id=user.id, session_id=session.id, access_ttl=ACCESS_TTL_SECONDS, refresh_ttl=REFRESH_TTL_SECONDS)
    return IssuedSession(
        session_id=session.id,
        access_token=access_token,
        refresh_token=refresh_token,
        csrf_token=csrf_token,
        access_ttl=ACCESS_TTL_SECONDS,
        refresh_ttl=REFRESH_TTL_SECONDS,
    )


async def _load_session_by_hash(
    db: AsyncSession,
    *,
    access_token: str | None = None,
    refresh_token: str | None = None,
) -> SessionTable | None:
    if not access_token and not refresh_token:
        return None

    stmt = select(SessionTable).options(selectinload(SessionTable.user))
    if access_token:
        stmt = stmt.where(SessionTable.access_token_hash == _hash_token(access_token))
    elif refresh_token:
        stmt = stmt.where(SessionTable.refresh_token_hash == _hash_token(refresh_token))

    result = await db.execute(stmt)
    return result.scalar_one_or_none()


def _ensure_session_usable(session: SessionTable | None, *, for_refresh: bool) -> SessionTable:
    if session is None:
        raise SessionAuthenticationError("Session not found.")
    if session.revoked_at is not None:
        raise SessionAuthenticationError("Session has been revoked.")

    now = utcnow()
    expiry = session.refresh_expires_at if for_refresh else session.access_expires_at
    if expiry <= now:
        raise SessionAuthenticationError("Session has expired.")
    return session


async def get_access_session(request: Request, db: AsyncSession) -> SessionTable:
    token = _get_access_token_from_request(request)
    if not token:
        raise SessionAuthenticationError("Missing access token.")
    session = await _load_session_by_hash(db, access_token=token)
    return _ensure_session_usable(session, for_refresh=False)


async def get_refresh_session(request: Request, db: AsyncSession) -> SessionTable:
    token = _get_refresh_token_from_request(request)
    if not token:
        raise SessionAuthenticationError("Missing refresh token.")
    session = await _load_session_by_hash(db, refresh_token=token)
    return _ensure_session_usable(session, for_refresh=True)


async def rotate_user_session(
    db: AsyncSession,
    session: SessionTable,
    request: Request | None = None,
) -> IssuedSession:
    _ensure_session_usable(session, for_refresh=True)

    access_token = secrets.token_urlsafe(48)
    refresh_token = secrets.token_urlsafe(64)
    csrf_token = secrets.token_urlsafe(32)
    now = utcnow()

    session.access_token_hash = _hash_token(access_token)
    session.refresh_token_hash = _hash_token(refresh_token)
    session.access_expires_at = now + timedelta(seconds=ACCESS_TTL_SECONDS)
    session.refresh_expires_at = now + timedelta(seconds=REFRESH_TTL_SECONDS)
    session.last_used_at = now
    session.last_refreshed_at = now
    session.user_agent_hash = _hash_optional_metadata(request.headers.get("user-agent") if request else None)
    session.ip_hash = _hash_optional_metadata(_extract_client_ip(request))

    await db.commit()
    await db.refresh(session)
    logger.info("session_rotated", "User session rotated", user_id=session.user_id, session_id=session.id, access_ttl=ACCESS_TTL_SECONDS, refresh_ttl=REFRESH_TTL_SECONDS)
    return IssuedSession(
        session_id=session.id,
        access_token=access_token,
        refresh_token=refresh_token,
        csrf_token=csrf_token,
        access_ttl=ACCESS_TTL_SECONDS,
        refresh_ttl=REFRESH_TTL_SECONDS,
    )


async def revoke_session(session: SessionTable, db: AsyncSession) -> None:
    if session.revoked_at is None:
        session.revoked_at = utcnow()
        await db.commit()
        logger.info("session_revoked", "User session revoked", user_id=session.user_id, session_id=session.id)


def access_ttl_for_session(session: SessionTable) -> int:
    remaining = int((session.access_expires_at - utcnow()).total_seconds())
    return max(0, remaining)


async def require_session(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> SessionTable:
    try:
        session = await get_access_session(request, db)
    except SessionAuthenticationError as exc:
        logger.warning("access_session_invalid", "Access session validation failed", error=str(exc), failure_reason="access_session_invalid")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.") from exc

    set_context(user_id=session.user_id, session_id=session.id)
    if session.user is None or not session.user.is_active:
        await revoke_session(session, db)
        logger.warning("access_session_inactive_user", "Access session belongs to an inactive user")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    return session


async def require_current_user(
    session: SessionTable = Depends(require_session),
) -> UserTable:
    return session.user


async def require_bound_user_id(
    user_id: str,
    current_user: UserTable = Depends(require_current_user),
) -> UserTable:
    if user_id != current_user.id:
        logger.warning("user_scope_mismatch", "Authenticated user attempted to access another user scope", requested_user_id=user_id, authenticated_user_id=current_user.id)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token does not grant access to this user.",
        )
    return current_user


async def require_refresh_session(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> SessionTable:
    try:
        session = await get_refresh_session(request, db)
    except SessionAuthenticationError as exc:
        logger.warning("refresh_session_invalid", "Refresh session validation failed", error=str(exc), failure_reason="refresh_session_invalid")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.") from exc

    set_context(user_id=session.user_id, session_id=session.id)
    if session.user is None or not session.user.is_active:
        await revoke_session(session, db)
        logger.warning("refresh_session_inactive_user", "Refresh session belongs to an inactive user")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    return session


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
