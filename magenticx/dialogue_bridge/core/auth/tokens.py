"""Mint and verify the stateless session JWTs (RS256).

Signing goes through ``core.auth.signing`` — OCI KMS in production, where the
private key never leaves an HSM. Verification is entirely local: a signature
check against a public key loaded at boot, with no network call and no session
row, which is what keeps the request path stateless.
"""
from __future__ import annotations

import asyncio
import base64
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from jose import jwt as jose_jwt, JWTError

from core.settings import KID_MAX, KID_MIN, settings
from core.auth.signing import SigningConfigError, SigningError, get_keyring
from core.logging import get_logger

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
    refresh_jti: str


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _now() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def _new_id() -> str:
    return uuid.uuid4().hex


async def _sign(claims: dict) -> str:
    # The kid sits inside the signed header, and the keyring signs with exactly
    # the key that kid names — a rotation can never produce a header that
    # disagrees with its own signature.
    keyring = get_keyring()
    header = {"alg": "RS256", "typ": "JWT", "kid": str(keyring.active_kid)}
    header_seg = _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_seg = _b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_seg}.{payload_seg}"
    try:
        signature = await keyring.sign(signing_input.encode("ascii"))
    except SigningError as exc:
        raise TokenError(f"Failed to sign session token: {exc}") from exc
    return f"{signing_input}.{_b64url(signature)}"


async def mint_tokens(
    user_id: str,
    *,
    sid: str | None = None,
    login_at: int | None = None,
    is_active: bool = True,
    pending_deletion: bool = False,
) -> IssuedTokens:
    """Mint an access + refresh JWT pair (RS256, signed via ``core.auth.signing``).

    A login mints a fresh ``sid``; a refresh reuses the original ``sid`` and
    ``login_at`` so the instant-logout denylist still covers the rotated tokens
    and the refresh lifetime is an absolute cap (it does not slide on refresh).

    Both tokens carry ``lat`` (the original sign-in time), so a sensitive action
    can demand a *recent* sign-in without a database read. ``pending_deletion``
    adds ``pdl``: the account is scheduled for deletion (plan 32) and the access
    path refuses everything but the few routes that let the user cancel, export
    or leave — again without a database read on the hot path.
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
        "lat": login_at,
        "exp": issued + cfg.access_ttl_seconds,
        "jti": _new_id(),
    }
    # Rolling refresh expiry: slide forward by the idle window on every mint, but
    # never past the absolute cap measured from the ORIGINAL login. On first login
    # login_at == issued, so exp = issued + idle; on rotation it re-slides, capped.
    refresh_jti = _new_id()
    refresh_exp = min(
        issued + cfg.refresh_idle_ttl_seconds,
        login_at + cfg.refresh_absolute_ttl_seconds,
    )
    refresh_claims = {
        **base,
        "typ": REFRESH_TYPE,
        "lat": login_at,
        "exp": refresh_exp,
        "jti": refresh_jti,
    }
    if pending_deletion:
        access_claims["pdl"] = True
        refresh_claims["pdl"] = True
    # Independent signatures: with KMS each is one network round trip, so
    # concurrently halves the wait a login spends on signing.
    access_token, refresh_token = await asyncio.gather(_sign(access_claims), _sign(refresh_claims))
    return IssuedTokens(
        session_id=sid,
        access_token=access_token,
        refresh_token=refresh_token,
        csrf_token=_new_id() + _new_id(),
        access_ttl=cfg.access_ttl_seconds,
        refresh_ttl=max(0, refresh_exp - issued),
        refresh_jti=refresh_jti,
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
    # Bound the kid before the lookup so a forged header can't ask for anything
    # outside the range settings accept for a configured key.
    if kid_version < KID_MIN or kid_version > KID_MAX:
        raise TokenError("Token key id out of range.")
    # Local lookup only — no network call on the request path, ever.
    try:
        pem = get_keyring().public_key_pem(kid_version)
    except SigningConfigError as exc:
        raise TokenError(f"Verification keys are unavailable: {exc}") from exc
    if pem is None:
        raise TokenError("Token key id is not recognised.")
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
