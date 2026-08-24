"""Authentication helpers used by the auth router.

The router keeps only request handling; everything it needs beyond that lives
here — the user lookups, the multi-account guards, and the login finaliser that
mints cookies (and parks the outgoing session on the "add another account" path).

Kept out of ``core/auth/`` on purpose: that package owns the *mechanism* (token
minting and verification, cookies, the parked-session store), while these are the
service's request-shaped helpers that compose it.
"""
from __future__ import annotations

from fastapi import HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.oidc import EntraOIDCError
from core.auth.parked import (
    ParkedAccountLimit,
    ParkedSessionError,
    new_device_id,
    parked_sessions,
)
from core.auth.session import (
    get_device_id,
    issue_device_cookie,
    issue_session_cookies,
    mint_login_session,
    refresh_guard,
    require_refresh_session,
    rotate_session,
)
from core.database import SessionLocal, UserTable
from core.settings import settings
from observability import get_logger, set_context
from schemas import AccountSummary

logger = get_logger(__name__)


async def load_user(db: AsyncSession, user_id: str) -> UserTable | None:
    result = await db.execute(select(UserTable).where(UserTable.id == user_id))
    return result.scalar_one_or_none()


async def guard_add_account(request: Request) -> None:
    """Reject an "add another account" attempt that would exceed the cap.

    Checked *before* authenticating: the cap is a security bound on how many live
    credentials one browser may hold, and failing early avoids both a pointless
    credential check and a successful login we would then have to discard.
    """
    if not settings.session.multi_account_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Multiple accounts are not enabled.",
        )
    device_id = get_device_id(request)
    if not device_id:
        return
    # +1 for the account currently active, which is about to be parked.
    if await parked_sessions.count(device_id) + 1 >= settings.session.max_parked_accounts:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"You can be signed in to at most {settings.session.max_parked_accounts} "
                "accounts. Sign out of one first."
            ),
        )


async def finalize_login(
    request: Request,
    response: Response,
    user: UserTable,
    *,
    park_previous: bool,
) -> "object":
    """Mint the session cookies for a successful login.

    When ``park_previous`` is set (the "add another account" path) the session
    that is *currently* active is rotated and parked before its cookies are
    overwritten, so the user keeps both. The outgoing session is read from the
    request, which still carries the old cookies at this point.

    A device cookie is (re)issued whenever multi-account is enabled, so the very
    first login establishes the browser's parked-session index.
    """
    issued = await mint_login_session(user)
    await refresh_guard.register(
        issued.session_id, issued.refresh_jti, settings.jwt.refresh_absolute_ttl_seconds
    )

    if settings.session.multi_account_enabled:
        device_id = get_device_id(request) or new_device_id()
        if park_previous:
            try:
                previous = await require_refresh_session(request)
                if previous.user_id != user.id:
                    previous_user = await load_user_active(previous.user_id)
                    rotated = await rotate_session(previous, is_active=previous_user)
                    await refresh_guard.rotate(
                        previous.id,
                        previous.jti,
                        rotated.refresh_jti,
                        settings.jwt.refresh_absolute_ttl_seconds,
                        settings.jwt.refresh_reuse_grace_seconds,
                    )
                    await parked_sessions.park(
                        device_id,
                        previous.user_id,
                        rotated.refresh_token,
                        settings.jwt.refresh_idle_ttl_seconds,
                    )
                    logger.info(
                        "account_parked",
                        "Parked the previous account while adding another",
                        previous_user_id=previous.user_id,
                    )
            except ParkedAccountLimit as exc:
                # Should be unreachable (guard_add_account ran first), but never
                # silently drop the previous account: tell the caller instead.
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)
                ) from exc
            except (HTTPException, ParkedSessionError):
                logger.warning(
                    "account_park_previous_failed",
                    "Could not park the previous account; it will need a fresh sign-in",
                    failure_reason="park_previous_failed",
                )
        # Also drop any stale parked entry for the account we just signed into, so
        # it is never listed as both active and switchable.
        await parked_sessions.drop(device_id, user.id)
        issue_device_cookie(response, device_id)

    set_context(user_id=user.id, session_id=issued.session_id)
    issue_session_cookies(response, issued)
    return issued


async def load_user_active(user_id: str) -> bool:
    """Whether a user is still active, without holding a request-scoped session.

    Used on the park path, where the outgoing account's row is not otherwise
    loaded; a deactivated account must not be parked as though it were usable.
    """
    try:
        async with SessionLocal() as db:
            user = await load_user(db, user_id)
            return bool(user and user.is_active)
    except SQLAlchemyError:
        logger.warning("park_user_lookup_failed", "Could not confirm the outgoing user is active")
        return False


def require_multi_account() -> None:
    """Fail closed when the feature is disabled, so it cannot even be probed."""
    if not settings.session.multi_account_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Multiple accounts are not enabled.",
        )


def account_summary(user: UserTable, *, current: bool, expired: bool = False) -> AccountSummary:
    return AccountSummary(
        id=user.id,
        username=user.username,
        email=user.email,
        display_name=getattr(user, "display_name", None),
        avatar_url=getattr(user, "avatar_url", None),
        is_active=user.is_active,
        current=current,
        expired=expired,
    )


def oidc_redirect_uri(request: Request) -> str:
    """The browser-facing callback URL registered in the Entra app. Prefer the
    explicit config (must match Entra exactly); fall back to the forwarded
    origin behind nginx for local convenience."""
    if settings.entra.redirect_uri:
        return settings.entra.redirect_uri
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if not host:
        raise EntraOIDCError("Cannot determine redirect URI; set ENTRA_REDIRECT_URI.")
    return f"{proto}://{host}/api/v1/auth/oidc/callback"


__all__ = [
    "account_summary",
    "finalize_login",
    "guard_add_account",
    "load_user",
    "load_user_active",
    "oidc_redirect_uri",
    "require_multi_account",
]
