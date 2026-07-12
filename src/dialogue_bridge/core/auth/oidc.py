"""Microsoft Entra ID OIDC Relying-Party flow (authorization-code + PKCE).

The bridge federates *identity* to Entra but keeps issuing its own session JWTs:
this module runs the browser redirect flow (via Microsoft's MSAL library),
validates the returned ``id_token``, enforces group membership, and hands back a
normalized :class:`AuthIdentity` — the same contract the userpass provider
returns — which the auth router feeds into ``upsert_user_from_identity`` +
``mint_login_session``. Nothing here touches the session-token layer.

MSAL is synchronous (it uses ``requests``), so every call that can hit the
network — app construction (authority discovery), the authorize-URL build, and
the code redemption (token endpoint + JWKS) — is dispatched to a worker thread
with ``asyncio.to_thread`` to avoid blocking the event loop.

The per-login ``state``/``nonce``/PKCE material is held in the MSAL "flow" dict,
stored single-use in Redis keyed by ``state`` (10-min TTL). That is the CSRF and
replay defense for the redirect: a callback whose ``state`` is unknown/expired,
or already consumed, is rejected.
"""
from __future__ import annotations

import asyncio
import json

import msal
import redis.asyncio as aioredis

from core.auth.providers import AuthIdentity
from core.redis import create_redis_client
from core.settings import settings
from observability import get_logger

logger = get_logger(__name__)

_FLOW_KEY_PREFIX = "auth:oidc:flow:"
_FLOW_TTL_SECONDS = 600  # 10 minutes to complete the redirect round-trip


class EntraOIDCError(Exception):
    """Raised when the OIDC flow cannot be started or completed (bad state,
    token error, or a failed group-membership check). Surfaced by the router as
    a clean redirect back to the login screen, never a stack trace to the user."""


class EntraOIDCDisabledError(EntraOIDCError):
    """The OIDC provider is not configured (missing tenant/client/secret)."""


class EntraAccessDeniedError(EntraOIDCError):
    """Authentication succeeded but the user is not authorized to sign in (not a
    member of an allowed group, or membership can't be verified). Distinct from a
    generic flow failure so the UI can say "you don't have access" rather than
    "something broke, try again"."""


# ---------------------------------------------------------------------------
# MSAL confidential-client app (lazy singleton — reused across logins)
# ---------------------------------------------------------------------------
_app: msal.ConfidentialClientApplication | None = None
_app_lock = asyncio.Lock()


def _build_app() -> msal.ConfidentialClientApplication:
    if not settings.entra.enabled:
        raise EntraOIDCDisabledError("Entra OIDC is not configured.")
    return msal.ConfidentialClientApplication(
        client_id=settings.entra.client_id,
        client_credential=settings.entra.client_secret.get_secret_value(),
        authority=settings.entra.authority,
    )


async def _get_app() -> msal.ConfidentialClientApplication:
    global _app
    if _app is not None:
        return _app
    async with _app_lock:
        if _app is None:
            # Construction performs authority/instance discovery (network) — run
            # it off the event loop.
            _app = await asyncio.to_thread(_build_app)
    return _app


# ---------------------------------------------------------------------------
# Redis-backed single-use flow store
# ---------------------------------------------------------------------------
_redis: aioredis.Redis | None = None
_redis_lock = asyncio.Lock()


async def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is not None:
        return _redis
    async with _redis_lock:
        if _redis is None:
            _redis = create_redis_client()
    return _redis


# ---------------------------------------------------------------------------
# Flow
# ---------------------------------------------------------------------------
async def begin_login(redirect_uri: str) -> str:
    """Start the auth-code flow: build the Entra authorize URL, persist the flow
    (state/nonce/PKCE) single-use in Redis, and return the URL to redirect to."""
    app = await _get_app()
    # prompt=select_account lets the user pick which Microsoft account to use.
    flow = await asyncio.to_thread(
        app.initiate_auth_code_flow,
        [],
        redirect_uri=redirect_uri,
        prompt="select_account",
    )
    state = flow.get("state")
    auth_uri = flow.get("auth_uri")
    if not state or not auth_uri:
        raise EntraOIDCError("MSAL did not return a usable authorization request.")
    client = await _get_redis()
    await client.setex(f"{_FLOW_KEY_PREFIX}{state}", _FLOW_TTL_SECONDS, json.dumps(flow))
    return auth_uri


async def complete_login(auth_response: dict) -> AuthIdentity:
    """Validate the callback: consume the stored flow by ``state``, redeem the
    code for an ``id_token`` (MSAL validates signature/iss/aud/nonce/exp), gate
    on group membership, and return the normalized identity."""
    state = auth_response.get("state")
    if not state:
        raise EntraOIDCError("Callback is missing the state parameter.")

    client = await _get_redis()
    key = f"{_FLOW_KEY_PREFIX}{state}"
    raw = await client.get(key)
    # Single-use: delete before redemption so a replayed callback can't reuse it.
    await client.delete(key)
    if not raw:
        raise EntraOIDCError("Unknown or expired authorization state.")
    flow = json.loads(raw)

    app = await _get_app()
    result = await asyncio.to_thread(app.acquire_token_by_auth_code_flow, flow, auth_response)

    if "error" in result:
        # error_description can carry PII/token hints — log the code only.
        logger.warning(
            "oidc_token_exchange_failed",
            "Entra token exchange failed",
            oidc_error=result.get("error"),
            failure_reason="oidc_token_exchange_failed",
        )
        raise EntraOIDCError(result.get("error") or "Token exchange failed.")

    claims = result.get("id_token_claims") or {}
    _enforce_group_membership(claims)

    subject = claims.get("oid") or claims.get("sub")
    if not subject:
        raise EntraOIDCError("id_token is missing a subject (oid/sub).")
    email = (
        claims.get("email")
        or claims.get("preferred_username")
        or claims.get("upn")
        or ""
    ).strip().lower() or None
    username = claims.get("preferred_username") or email or subject
    groups = tuple(claims.get("groups") or ())

    return AuthIdentity(
        subject=subject,
        username=username,
        provider="entra",
        email=email,
        groups=groups,
        claims={"name": claims.get("name"), "tid": claims.get("tid")},
    )


def _enforce_group_membership(claims: dict) -> None:
    """Fail closed unless the user is in one of the allowed Entra groups.

    No allowed groups configured → no restriction. If the token carries a groups
    "overage" marker (the user is in too many groups for Entra to inline them),
    we cannot prove membership from the token and deny — use a small dedicated
    security group (or App Roles) to avoid this.
    """
    allowed = settings.entra.allowed_groups
    if not allowed:
        return

    if "_claim_names" in claims or "_claim_sources" in claims or claims.get("hasgroups"):
        logger.warning(
            "oidc_group_overage",
            "Entra groups claim overflowed (overage) — cannot verify membership from token",
            failure_reason="oidc_group_overage",
        )
        raise EntraAccessDeniedError("Group membership could not be verified (groups overage).")

    token_groups = {g for g in (claims.get("groups") or []) if g}
    if token_groups.isdisjoint(allowed):
        logger.warning(
            "oidc_group_denied",
            "Entra user is not a member of any allowed group",
            failure_reason="oidc_group_denied",
        )
        raise EntraAccessDeniedError("User is not a member of an allowed group.")
