from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from observability import get_logger, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import UserTable, get_db, upsert_user_from_vault
from schemas import AuthRequest, AuthResponse
from core.security.rate_limit import AUTHENTICATE_LIMIT, limiter
from core.settings import settings
from core.auth.session import (
    AuthContext,
    access_ttl_for_session,
    build_auth_response,
    clear_session_cookies,
    issue_session_cookies,
    logout_denylist,
    mint_login_session,
    refresh_guard,
    require_csrf_protection,
    require_refresh_session,
    require_session,
    revoke_current_session,
    rotate_session,
)
from core.auth.providers import get_provider
from core.auth.vault import VaultAuthError


router = APIRouter()
logger = get_logger(__name__)


async def _load_user(db: AsyncSession, user_id: str) -> UserTable | None:
    result = await db.execute(select(UserTable).where(UserTable.id == user_id))
    return result.scalar_one_or_none()


@router.post("/login", response_model=AuthResponse, status_code=status.HTTP_200_OK)
@limiter.limit(AUTHENTICATE_LIMIT)
async def authenticate(
    creds: AuthRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """Authenticate the user against Vault and issue stateless, Vault-signed session JWTs."""
    try:
        identity = await get_provider("vault").authenticate(
            {"username": creds.username, "password": creds.password}
        )
    except VaultAuthError as exc:
        if exc.status_code in (400, 401, 403):
            logger.warning(
                "auth_login_failed",
                "Vault authentication failed",
                vault_status_code=exc.status_code,
                failure_reason="invalid_credentials",
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid username or password.",
            ) from exc
        logger.error(
            "auth_login_failed",
            "Vault authentication failed",
            exc_info=True,
            vault_status_code=exc.status_code,
            failure_reason="vault_unavailable",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Authentication service is unavailable.",
        ) from exc
    except RuntimeError as exc:
        logger.error(
            "auth_service_not_configured",
            "Authentication service is not configured",
            failure_reason="auth_service_not_configured",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Authentication service is temporarily unavailable. Please try again later.",
        ) from exc
    except Exception as exc:
        logger.exception("auth_unexpected_error", "Unexpected error during authentication", failure_reason="unexpected_error")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Sign in failed. Please try again.",
        ) from exc

    login_time = datetime.now(timezone.utc).replace(tzinfo=None)

    user = await upsert_user_from_vault(
        db,
        vault_user_id=identity.subject,
        username=identity.username,
        metadata={"last_login_at": login_time},
    )

    if not user.is_active:
        logger.warning("auth_user_inactive", "Authenticated user is inactive", user_id=user.id, failure_reason="inactive_user")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User access has been disabled.",
        )

    user.last_login_at = login_time
    await db.commit()
    await db.refresh(user)

    issued = await mint_login_session(user)
    # Record the refresh jti as the session's current one, so a later replay of an
    # already-rotated (e.g. stolen) refresh token is detected on the next refresh.
    await refresh_guard.register(
        issued.session_id, issued.refresh_jti, settings.jwt.refresh_absolute_ttl_seconds
    )
    set_context(user_id=user.id, session_id=issued.session_id)
    issue_session_cookies(response, issued)
    logger.info("auth_login_succeeded", "User authenticated successfully")
    return AuthResponse(**build_auth_response(user, issued.access_ttl))


@router.get("/session", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def session_me(
    ctx: AuthContext = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    user = await _load_user(db, ctx.user_id)
    if user is None or not user.is_active:
        logger.warning("session_me_user_invalid", "Session belongs to a missing or inactive user")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    set_context(user_id=ctx.user_id, session_id=ctx.id)
    logger.debug("session_me", "Session introspection succeeded")
    return AuthResponse(**build_auth_response(user, access_ttl_for_session(ctx)))


@router.post("/session/refresh", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def refresh_session(
    response: Response,
    _: None = Depends(require_csrf_protection),
    ctx: AuthContext = Depends(require_refresh_session),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    # Refresh-token reuse detection FIRST — a replayed old refresh token must not
    # even touch the DB. An old jti presented past the grace window means the
    # token was stolen/replayed → revoke the whole session so neither the
    # attacker's nor the victim's copy survives; both are forced to re-authenticate.
    if await refresh_guard.status(ctx.id, ctx.jti) == "reuse":
        await logout_denylist.revoke(ctx.id, settings.jwt.refresh_absolute_ttl_seconds)
        clear_session_cookies(response)
        logger.warning(
            "refresh_token_reuse_detected",
            "Refresh token reuse detected — session revoked",
            failure_reason="refresh_token_reuse",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")

    user = await _load_user(db, ctx.user_id)
    if user is None or not user.is_active:
        clear_session_cookies(response)
        logger.warning("refresh_user_invalid", "Refresh belongs to a missing or inactive user")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    issued = await rotate_session(ctx, is_active=user.is_active)
    # Advance the tracked jti to the freshly-minted one and grace the old jti, so a
    # legitimate concurrent/retried refresh in flight isn't misread as reuse.
    await refresh_guard.rotate(
        ctx.id, ctx.jti, issued.refresh_jti,
        settings.jwt.refresh_absolute_ttl_seconds,
        settings.jwt.refresh_reuse_grace_seconds,
    )
    set_context(user_id=user.id, session_id=issued.session_id)
    issue_session_cookies(response, issued)
    logger.info("session_refresh_succeeded", "Session refresh succeeded")
    return AuthResponse(**build_auth_response(user, issued.access_ttl))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    _: None = Depends(require_csrf_protection),
) -> Response:
    sid = await revoke_current_session(request)
    clear_session_cookies(response)
    logger.info("logout_completed", "Logout completed", had_session=sid is not None)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
