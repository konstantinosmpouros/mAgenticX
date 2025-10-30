import asyncio
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt


class TokenVerificationError(Exception):
    """Raised when a JWT cannot be validated."""


SESSION_COOKIE_NAME = os.getenv("SESSION_COOKIE_NAME", "mx_session")
SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
SESSION_COOKIE_DOMAIN = os.getenv("SESSION_COOKIE_DOMAIN")
SESSION_COOKIE_SAMESITE = os.getenv("SESSION_COOKIE_SAMESITE", "lax")
SESSION_REFRESH_COOKIE_NAME = os.getenv("SESSION_REFRESH_COOKIE_NAME", f"{SESSION_COOKIE_NAME}_refresh")


@dataclass(slots=True)
class VaultJWTVerifierSettings:
    discovery_url: str
    audience: Optional[str]
    timeout: float

    @classmethod
    def from_env(cls) -> "VaultJWTVerifierSettings":
        discovery_url = os.getenv("VAULT_OIDC_DISCOVERY_URL")
        vault_addr = os.getenv("VAULT_ADDR")
        if not discovery_url:
            if not vault_addr:
                raise RuntimeError(
                    "VAULT_ADDR must be configured to verify Vault-issued JWTs."
                )
            discovery_url = (
                f"{vault_addr.rstrip('/')}/v1/identity/oidc/.well-known/openid-configuration"
            )

        timeout = float(os.getenv("VAULT_HTTP_TIMEOUT", "10"))
        audience = os.getenv("VAULT_JWT_AUDIENCE")
        return cls(
            discovery_url=discovery_url,
            audience=audience,
            timeout=timeout,
        )


class VaultJWTVerifier:
    """Fetches Vault's JWKS and verifies tokens issued by the OIDC provider."""

    def __init__(self, settings: VaultJWTVerifierSettings):
        self._settings = settings
        self._jwks_by_kid: Dict[str, Dict[str, Any]] = {}
        self._issuer: Optional[str] = None
        self._last_loaded: float = 0.0
        self._lock = asyncio.Lock()
        self._cache_ttl_seconds = 300.0

    async def verify(self, token: str) -> Dict[str, Any]:
        await self._ensure_keys()
        try:
            header = jwt.get_unverified_header(token)
        except JWTError as exc:
            raise TokenVerificationError("Malformed JWT header") from exc

        kid = header.get("kid")
        if not kid:
            raise TokenVerificationError("JWT header missing 'kid'")

        key = self._jwks_by_kid.get(kid)
        if key is None:
            # JWKS might have rotated—force refresh once.
            await self._ensure_keys(force=True)
            key = self._jwks_by_kid.get(kid)
            if key is None:
                raise TokenVerificationError("Unrecognized token key id")

        algorithms = [key.get("alg", "RS256")]
        options = {"verify_aud": self._settings.audience is not None}

        try:
            return jwt.decode(
                token,
                key,
                algorithms=algorithms,
                audience=self._settings.audience,
                issuer=self._issuer,
                options=options,
            )
        except JWTError as exc:
            raise TokenVerificationError(f"Invalid JWT: {exc}") from exc

    async def _ensure_keys(self, *, force: bool = False) -> None:
        if not force and self._jwks_by_kid:
            if (time.time() - self._last_loaded) < self._cache_ttl_seconds:
                return

        async with self._lock:
            if not force and self._jwks_by_kid:
                if (time.time() - self._last_loaded) < self._cache_ttl_seconds:
                    return
            await self._refresh_metadata()

    async def _refresh_metadata(self) -> None:
        async with httpx.AsyncClient(timeout=self._settings.timeout) as client:
            try:
                discovery_resp = await client.get(self._settings.discovery_url)
                discovery_resp.raise_for_status()
                discovery_data = discovery_resp.json()
            except httpx.HTTPError as exc:
                raise TokenVerificationError(
                    f"Failed to load Vault discovery document: {exc}"
                ) from exc

            jwks_uri = discovery_data.get("jwks_uri")
            issuer = discovery_data.get("issuer")
            if not jwks_uri or not issuer:
                raise TokenVerificationError(
                    "Vault discovery document missing jwks_uri or issuer"
                )

            try:
                jwks_resp = await client.get(jwks_uri)
                jwks_resp.raise_for_status()
                jwks_data = jwks_resp.json()
            except httpx.HTTPError as exc:
                raise TokenVerificationError(
                    f"Failed to load Vault JWKS: {exc}"
                ) from exc

        keys = jwks_data.get("keys") or []
        mapped = {
            key["kid"]: key
            for key in keys
            if isinstance(key, dict) and key.get("kid")
        }
        if not mapped:
            raise TokenVerificationError("Vault JWKS did not return any usable keys")

        self._jwks_by_kid = mapped
        self._issuer = issuer
        self._last_loaded = time.time()


_jwt_verifier: Optional[VaultJWTVerifier] = None
_bearer_scheme = HTTPBearer(auto_error=False)


def get_jwt_verifier() -> VaultJWTVerifier:
    global _jwt_verifier
    if _jwt_verifier is None:
        settings = VaultJWTVerifierSettings.from_env()
        _jwt_verifier = VaultJWTVerifier(settings)
    return _jwt_verifier


async def require_access_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> str:
    token: Optional[str] = None

    if credentials is not None and credentials.scheme.lower() == "bearer":
        token = credentials.credentials.strip()

    if not token and request is not None:
        cookie_token = request.cookies.get(SESSION_COOKIE_NAME)
        if cookie_token:
            token = cookie_token.strip()

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )
    return token


async def require_token_claims(
    token: str = Depends(require_access_token),
) -> Dict[str, Any]:
    try:
        verifier = get_jwt_verifier()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    try:
        return await verifier.verify(token)
    except TokenVerificationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc


async def require_refresh_token(
    request: Request,
) -> str:
    token = request.cookies.get(SESSION_REFRESH_COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing refresh token",
        )
    return token.strip()
