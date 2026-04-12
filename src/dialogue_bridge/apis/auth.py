from datetime import datetime
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from observability import log_event, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from database import UserTable, get_db, upsert_user_from_vault
from database.schemas import AuthRequest, AuthResponse
from utils.rate_limit import AUTHENTICATE_LIMIT, limiter
from vault_auth.session_auth import (
    build_auth_response,
    clear_session_cookies,
    create_user_session,
    issue_session_cookies,
    require_csrf_protection,
    require_current_user,
    require_refresh_session,
    require_session,
    rotate_user_session,
    revoke_session,
    get_access_session,
    get_refresh_session,
    SessionAuthenticationError,
    access_ttl_for_session,
)
from vault_auth.client import VaultAuthError, VaultAuthenticator


router = APIRouter(tags=["Auth"])
logger = logging.getLogger(__name__)

try:
    _vault_authenticator = VaultAuthenticator()
except RuntimeError:
    _vault_authenticator = None


@router.post("/authenticate", response_model=AuthResponse, status_code=status.HTTP_200_OK)
@limiter.limit(AUTHENTICATE_LIMIT)
async def authenticate(
    creds: AuthRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """
    Authenticate the user against Vault and issue bridge-managed session cookies.
    """
    if _vault_authenticator is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Authentication service is not configured.",
        )

    try:
        auth_result = await _vault_authenticator.authenticate(creds.username, creds.password)
    except VaultAuthError as exc:
        level = logging.WARNING if exc.status_code in (400, 401, 403) else logging.ERROR
        log_event(
            logger,
            level,
            "auth_login_failed",
            "Vault authentication failed",
            username=creds.username,
            vault_status_code=exc.status_code,
        )
        if exc.status_code in (400, 401, 403):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid username or password.",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Authentication service is unavailable.",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Authentication failed.",
        ) from exc

    login_time = datetime.utcnow()

    user = await upsert_user_from_vault(
        db,
        vault_user_id=auth_result.vault_user_id,
        username=auth_result.username,
        metadata={"last_login_at": login_time},
    )

    if not user.is_active:
        log_event(
            logger,
            logging.WARNING,
            "auth_user_inactive",
            "Authenticated user is inactive",
            user_id=user.id,
            username=user.username,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User access has been disabled.",
        )

    user.last_login_at = login_time
    await db.commit()
    await db.refresh(user)

    issued = await create_user_session(db, user, request)
    set_context(user_id=user.id, session_id=issued.session_id)
    issue_session_cookies(response, issued)
    log_event(logger, logging.INFO, "auth_login_succeeded", "User authenticated successfully")
    return AuthResponse(**build_auth_response(user, issued.access_ttl))


@router.get("/session/me", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def session_me(
    current_user: UserTable = Depends(require_current_user),
    session=Depends(require_session),
) -> AuthResponse:
    set_context(user_id=current_user.id, session_id=session.id)
    log_event(logger, logging.DEBUG, "session_me", "Session introspection succeeded")
    return AuthResponse(**build_auth_response(current_user, access_ttl_for_session(session)))


@router.post("/session/refresh", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def refresh_session(
    request: Request,
    response: Response,
    _: None = Depends(require_csrf_protection),
    session=Depends(require_refresh_session),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    issued = await rotate_user_session(db, session, request)
    set_context(user_id=session.user.id, session_id=issued.session_id)
    issue_session_cookies(response, issued)
    log_event(logger, logging.INFO, "session_refresh_succeeded", "Session refresh succeeded")
    return AuthResponse(**build_auth_response(session.user, issued.access_ttl))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> Response:
    session = None
    try:
        session = await get_access_session(request, db)
    except SessionAuthenticationError:
        try:
            session = await get_refresh_session(request, db)
        except SessionAuthenticationError:
            session = None

    if session is not None:
        set_context(user_id=session.user_id, session_id=session.id)
        await revoke_session(session, db)

    clear_session_cookies(response)
    log_event(logger, logging.INFO, "logout_completed", "Logout completed", had_session=session is not None)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
