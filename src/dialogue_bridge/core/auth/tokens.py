from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from jose import jwt as jose_jwt, JWTError

from core.settings import settings
from core.auth.vault import VaultServiceError, vault_service
from observability import get_logger

logger = get_logger(__name__)

ACCESS_TYPE = "access"
REFRESH_TYPE = "refresh"


class TokenError(Exception):
    """Raised when a session JWT cannot be minted or verified."""


@dataclass(slots=True)
class IssuedTokens:
    session_id: str
    access_token: str
    refresh_token: str
    csrf_token: str
    access_ttl: int
    refresh_ttl: int


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _now() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def _new_id() -> str:
    return uuid.uuid4().hex


async def _sign(claims: dict) -> str:
    # The kid must be inside the (signed) header, so resolve the signing key
    # version first and sign with exactly that version — never the "latest"
    # default, which could race a rotation and mismatch the header kid.
    version = await vault_service.current_sign_version()
    header = {"alg": "RS256", "typ": "JWT", "kid": str(version)}
    header_seg = _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_seg = _b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_seg}.{payload_seg}"
    try:
        signature = await vault_service.sign(signing_input, version)
    except VaultServiceError as exc:
        raise TokenError(f"Failed to sign token via Vault Transit: {exc}") from exc
    return f"{signing_input}.{signature}"


async def mint_tokens(
    user_id: str,
    *,
    sid: str | None = None,
    login_at: int | None = None,
    is_active: bool = True,
) -> IssuedTokens:
    """Mint an access + refresh JWT pair (RS256, Vault-Transit-signed).

    A login mints a fresh ``sid``; a refresh reuses the original ``sid`` and
    ``login_at`` so the instant-logout denylist still covers the rotated tokens
    and the refresh lifetime is an absolute cap (it does not slide on refresh).
    """
    cfg = settings.jwt
    sid = sid or _new_id()
    issued = _now()
    login_at = login_at or issued
    base = {"iss": cfg.issuer, "aud": cfg.audience, "iat": issued, "nbf": issued, "sub": user_id, "sid": sid}

    access_claims = {
        **base,
        "typ": ACCESS_TYPE,
        "act": is_active,
        "exp": issued + cfg.access_ttl_seconds,
        "jti": _new_id(),
    }
    refresh_claims = {
        **base,
        "typ": REFRESH_TYPE,
        "lat": login_at,
        "exp": login_at + cfg.refresh_ttl_seconds,
        "jti": _new_id(),
    }
    access_token = await _sign(access_claims)
    refresh_token = await _sign(refresh_claims)
    return IssuedTokens(
        session_id=sid,
        access_token=access_token,
        refresh_token=refresh_token,
        csrf_token=_new_id() + _new_id(),
        access_ttl=cfg.access_ttl_seconds,
        refresh_ttl=max(0, refresh_claims["exp"] - issued),
    )


async def verify(token: str, expected_type: str) -> dict:
    """Verify a session JWT and return its claims, or raise ``TokenError``.

    Fails closed on anything suspect: RS256-only (rejects ``none``/HS confusion),
    required iss/aud/exp/iat/nbf, and an exact token-``typ`` match so an access
    token cannot be replayed at the refresh endpoint (or vice versa).
    """
    cfg = settings.jwt
    try:
        header = jose_jwt.get_unverified_header(token)
    except JWTError as exc:
        raise TokenError(f"Malformed token header: {exc}") from exc
    kid = header.get("kid")
    if not kid or not str(kid).isdigit():
        raise TokenError("Token header missing a valid key id.")
    kid_version = int(kid)
    # Bound the version before touching Vault so a forged kid can't trigger an
    # unbounded key lookup; real Transit versions are small monotonic integers.
    if kid_version < 1 or kid_version > 100_000:
        raise TokenError("Token key id out of range.")
    try:
        pem = await vault_service.public_key_pem(kid_version)
    except VaultServiceError as exc:
        raise TokenError(f"Could not load verification key: {exc}") from exc
    try:
        claims = jose_jwt.decode(
            token,
            pem,
            algorithms=["RS256"],
            audience=cfg.audience,
            issuer=cfg.issuer,
            options={
                "verify_signature": True,
                "verify_aud": True,
                "verify_iss": True,
                "verify_exp": True,
                "verify_nbf": True,
                "verify_iat": True,
                "require_exp": True,
                "require_iat": True,
                "require_nbf": True,
                "require_sub": True,
                "require_aud": True,
                "require_iss": True,
                "leeway": cfg.leeway_seconds,
            },
        )
    except JWTError as exc:
        raise TokenError(f"Token verification failed: {exc}") from exc
    if claims.get("typ") != expected_type:
        raise TokenError("Token type mismatch.")
    if not claims.get("sub") or not claims.get("sid"):
        raise TokenError("Token missing subject or session id.")
    return claims
