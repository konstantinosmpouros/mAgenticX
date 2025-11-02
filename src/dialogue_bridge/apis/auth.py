import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, upsert_user_from_vault, UserTable
from database.schemas import AuthRequest, AuthResponse
from vault_auth.auth import (
    SESSION_COOKIE_DOMAIN,
    SESSION_COOKIE_NAME,
    SESSION_COOKIE_SAMESITE,
    SESSION_COOKIE_SECURE,
    SESSION_REFRESH_COOKIE_NAME,
    TokenVerificationError,
    get_jwt_verifier,
    require_refresh_token,
)
from vault_auth.client import VaultAuthError, VaultAuthenticator


router = APIRouter(tags=["Auth"])

_vault_authenticator: VaultAuthenticator | None = None
_DEFAULT_TOKEN_TTL = int(os.getenv("SESSION_COOKIE_DEFAULT_TTL", "3600"))


def get_vault_authenticator() -> VaultAuthenticator:
    global _vault_authenticator
    if _vault_authenticator is None:
        _vault_authenticator = VaultAuthenticator()
    return _vault_authenticator


@router.post("/authenticate", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def authenticate(
    creds: AuthRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """
    Authenticate the user against Vault, ensure they exist locally, and return a JWT.
    """
    try:
        authenticator = get_vault_authenticator()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    try:
        auth_result = await authenticator.authenticate(creds.username, creds.password)
    except VaultAuthError as exc:
        status_code = exc.status_code or status.HTTP_500_INTERNAL_SERVER_ERROR
        if status_code < 400 or status_code >= 500:
            status_code = status.HTTP_502_BAD_GATEWAY
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    login_time = datetime.utcnow()

    user = await upsert_user_from_vault(
        db,
        vault_user_id=auth_result.vault_user_id,
        username=auth_result.username,
        metadata={"last_login_at": login_time},
    )

    user.last_login_at = login_time
    await db.commit()
    await db.refresh(user)

    max_age = auth_result.ttl if auth_result.ttl and auth_result.ttl > 0 else _DEFAULT_TOKEN_TTL
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=auth_result.jwt,
        max_age=max_age,
        expires=max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=SESSION_COOKIE_DOMAIN,
        path="/",
    )

    refresh_max_age = (
        auth_result.client_token_ttl
        if auth_result.client_token_ttl and auth_result.client_token_ttl > 0
        else max_age
    )
    response.set_cookie(
        key=SESSION_REFRESH_COOKIE_NAME,
        value=auth_result.client_token,
        max_age=refresh_max_age,
        expires=refresh_max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=SESSION_COOKIE_DOMAIN,
        path="/",
    )

    return AuthResponse(
        authenticated=True,
        user_id=user.id,
        user=user,
        tokenTtl=auth_result.ttl,
        vaultUserId=auth_result.vault_user_id,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> Response:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        domain=SESSION_COOKIE_DOMAIN,
    )
    response.delete_cookie(
        key=SESSION_REFRESH_COOKIE_NAME,
        path="/",
        domain=SESSION_COOKIE_DOMAIN,
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/session/refresh", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def refresh_session(
    response: Response,
    refresh_token: str = Depends(require_refresh_token),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    try:
        authenticator = get_vault_authenticator()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    try:
        refresh_result = await authenticator.refresh_session(refresh_token)
    except VaultAuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    try:
        verifier = get_jwt_verifier()
        claims = await verifier.verify(refresh_result.jwt)
    except (RuntimeError, TokenVerificationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc

    identifiers: set[str] = set()
    for key in ("sub", "entity_id", "user_id", "id"):
        value = claims.get(key)
        if value is not None:
            identifiers.add(str(value))
    metadata = claims.get("metadata")
    if isinstance(metadata, dict):
        for key in ("vault_user_id", "user_id", "id"):
            value = metadata.get(key)
            if value is not None:
                identifiers.add(str(value))

    if not identifiers:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token missing subject identifiers.",
        )

    stmt = select(UserTable).where(
        or_(
            UserTable.id.in_(identifiers),
            UserTable.vault_user_id.in_(identifiers),
        )
    )
    result = await db.execute(stmt)
    user: UserTable | None = result.scalars().first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not recognized for refreshed token.",
        )

    max_age = (
        refresh_result.ttl
        if refresh_result.ttl and refresh_result.ttl > 0
        else _DEFAULT_TOKEN_TTL
    )
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=refresh_result.jwt,
        max_age=max_age,
        expires=max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=SESSION_COOKIE_DOMAIN,
        path="/",
    )

    refresh_max_age = (
        refresh_result.client_token_ttl
        if refresh_result.client_token_ttl and refresh_result.client_token_ttl > 0
        else max_age
    )
    response.set_cookie(
        key=SESSION_REFRESH_COOKIE_NAME,
        value=refresh_token,
        max_age=refresh_max_age,
        expires=refresh_max_age,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        domain=SESSION_COOKIE_DOMAIN,
        path="/",
    )

    return AuthResponse(
        authenticated=True,
        user_id=user.id,
        user=user,
        tokenTtl=refresh_result.ttl,
        vaultUserId=user.vault_user_id,
    )
