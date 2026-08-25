from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from core.logging import get_logger, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import UserTable, get_db, upsert_user_from_identity, IdentityConflictError
from schema import (
    AccountListResponse,
    AccountSummary,
    AuthRequest,
    AuthResponse,
    SwitchAccountRequest,
)
from core.security.rate_limit import auth_rate_limit, refresh_rate_limit
from core.settings import settings
from core.auth.session import (
    AuthContext,
    clear_device_cookie,
    get_device_id,
    issue_device_cookie,
    resolve_parked_refresh,
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
from core.auth.parked import (
    ParkedAccountLimit,
    ParkedSessionError,
    new_device_id,
    parked_sessions,
)
from utils.auth import (
    account_summary,
    finalize_login,
    guard_add_account,
    load_user,
    oidc_redirect_uri,
    require_multi_account,
)
from core.auth.providers import get_provider
from core.auth.vault import VaultAuthError
from core.auth.oidc import (
    begin_login,
    complete_login,
    consume_park_intent,
    EntraOIDCError,
    EntraAccessDeniedError,
)


router = APIRouter()
logger = get_logger(__name__)


@router.post(
    "/login",
    response_model=AuthResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(auth_rate_limit)],  # per-IP brute-force guard
)
async def authenticate(
    creds: AuthRequest,
    request: Request,
    response: Response,
    park: bool = False,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """Authenticate against Vault and issue stateless, Vault-signed session JWTs.

    ``?park=true`` is the "add another account" path: the session that is already
    active is parked instead of replaced, so the browser ends up signed in to
    both. It is honoured only when multi-account is enabled and the cap allows it.
    """
    if park:
        await guard_add_account(request)
    try:
        identity = await get_provider("vault").authenticate(
            {"username": creds.username, "password": creds.password}
        )
    except VaultAuthError as exc:
        # 404 too: Vault returns it for a login path that doesn't route (e.g. a
        # username containing "@", which userpass forbids) — that's a bad
        # username, not a service outage, so surface it as invalid credentials
        # rather than a misleading "service unavailable".
        if exc.status_code in (400, 401, 403, 404):
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

    user = await upsert_user_from_identity(
        db,
        provider="vault",
        subject=identity.subject,
        username=identity.username,
        email=identity.email,
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

    # _finalize_login records the refresh jti as the session's current one, so a
    # later replay of an already-rotated (e.g. stolen) refresh token is detected.
    issued = await finalize_login(request, response, user, park_previous=park)
    logger.info("auth_login_succeeded", "User authenticated successfully", added_account=park)
    return AuthResponse(**build_auth_response(user, issued.access_ttl))


@router.get("/session", response_model=AuthResponse, status_code=status.HTTP_200_OK)
async def session_me(
    ctx: AuthContext = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    user = await load_user(db, ctx.user_id)
    if user is None or not user.is_active:
        logger.warning("session_me_user_invalid", "Session belongs to a missing or inactive user")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    set_context(user_id=ctx.user_id, session_id=ctx.id)
    logger.debug("session_me", "Session introspection succeeded")
    return AuthResponse(**build_auth_response(user, access_ttl_for_session(ctx)))


@router.post(
    "/session/refresh",
    response_model=AuthResponse,
    status_code=status.HTTP_200_OK,
    # Token mint hits Vault Transit — per-IP ceiling on the pre-auth path.
    dependencies=[Depends(refresh_rate_limit)],
)
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

    user = await load_user(db, ctx.user_id)
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
    revoked = await revoke_current_session(request)
    sid, revoked_user_id = revoked if revoked else (None, None)
    clear_session_cookies(response)
    # Logging out of the active account must also forget it as a *parked* one, or
    # it would reappear in the switcher as something to switch back into. The id
    # comes from the revoked token rather than a fresh require_session, so this
    # still works when the access token has already expired.
    device_id = get_device_id(request)
    if device_id and revoked_user_id:
        await parked_sessions.drop(device_id, revoked_user_id)
    logger.info("logout_completed", "Logout completed", had_session=sid is not None)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


# ---------------------------------------------------------------------------
# Multi-account: several signed-in accounts per browser, one active at a time.
#
# The active account always uses the normal session cookies; the others are
# "parked" server-side (core/auth/parked.py). Every endpoint here requires a
# valid ACTIVE session on top of the device cookie - the device cookie alone must
# never be enough, or one stolen cookie would escalate to every parked account.
# ---------------------------------------------------------------------------
@router.get(
    "/accounts",
    response_model=AccountListResponse,
    status_code=status.HTTP_200_OK,
    # Deliberately NOT on auth_rate_limit: that is the per-IP *credential* bucket
    # for login/refresh. An authenticated UI read sharing it means any chatty
    # client burns the budget that protects sign-in — which is exactly what a
    # render loop here did once. The global per-identity budget middleware still
    # covers this route.
)
async def list_accounts(
    request: Request,
    ctx: AuthContext = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> AccountListResponse:
    """The accounts this browser can switch between, the active one first.

    Identities are read from Postgres rather than stored beside the parked token,
    so a Redis dump cannot also leak who is signed in on which browser.
    """
    require_multi_account()
    set_context(user_id=ctx.user_id, session_id=ctx.id)

    active = await load_user(db, ctx.user_id)
    if active is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")

    accounts = [account_summary(active, current=True)]
    device_id = get_device_id(request)
    if device_id:
        for user_id in await parked_sessions.list_user_ids(device_id):
            if user_id == ctx.user_id:
                continue
            parked_user = await load_user(db, user_id)
            if parked_user is None:
                # The account was deleted while parked - drop the dangling entry.
                await parked_sessions.drop(device_id, user_id)
                continue
            accounts.append(account_summary(parked_user, current=False))

    max_accounts = settings.session.max_parked_accounts
    return AccountListResponse(
        accounts=accounts,
        canAddAccount=len(accounts) < max_accounts,
        maxAccounts=max_accounts,
    )


@router.post(
    "/accounts/switch",
    response_model=AuthResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(refresh_rate_limit)],
)
async def switch_account(
    payload: SwitchAccountRequest,
    request: Request,
    response: Response,
    _: None = Depends(require_csrf_protection),
    ctx: AuthContext = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    """Promote a parked account to active, parking the outgoing one.

    Three factors are required - a valid active session, the device cookie and a
    CSRF token - so neither a stolen device cookie nor a cross-site request can
    move a browser between identities.

    Every cookie is replaced in this single response, and both directions rotate
    their refresh token, so a captured parked token is single-use and its replay
    trips the refresh guard.
    """
    require_multi_account()
    device_id = get_device_id(request)
    if not device_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This browser has no other accounts signed in.",
        )
    if payload.user_id == ctx.user_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That account is already active.")

    # Take the parked token first: if this fails nothing has changed yet, so the
    # caller simply stays signed in as whoever they already were.
    try:
        parked_token = await parked_sessions.take(device_id, payload.user_id)
    except ParkedSessionError as exc:
        logger.warning(
            "account_switch_unavailable",
            "Could not take the parked session",
            failure_reason="parked_session_unavailable",
        )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    try:
        parked_ctx = await resolve_parked_refresh(parked_token)
    except Exception as exc:
        logger.warning(
            "account_switch_rejected",
            "Parked refresh token did not verify",
            failure_reason="parked_refresh_invalid",
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="That session has expired. Please sign in again.",
        ) from exc

    if parked_ctx.user_id != payload.user_id:
        # The stored blob is AAD-bound to (device, user), so this should be
        # unreachable; treat a mismatch as tampering rather than a mistake.
        logger.error(
            "account_switch_identity_mismatch",
            "Parked token subject does not match the requested account",
            failure_reason="parked_identity_mismatch",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")

    target = await load_user(db, payload.user_id)
    if target is None or not target.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User access has been disabled.")

    # Mint the incoming session, preserving its sid so the denylist and the
    # absolute refresh cap keep applying to the original login.
    issued = await rotate_session(parked_ctx, is_active=target.is_active)
    await refresh_guard.rotate(
        parked_ctx.id,
        parked_ctx.jti,
        issued.refresh_jti,
        settings.jwt.refresh_absolute_ttl_seconds,
        settings.jwt.refresh_reuse_grace_seconds,
    )

    # Park the outgoing account with a rotated token of its own.
    outgoing = await load_user(db, ctx.user_id)
    if outgoing is not None:
        try:
            outgoing_refresh = await require_refresh_session(request)
            outgoing_issued = await rotate_session(outgoing_refresh, is_active=outgoing.is_active)
            await refresh_guard.rotate(
                outgoing_refresh.id,
                outgoing_refresh.jti,
                outgoing_issued.refresh_jti,
                settings.jwt.refresh_absolute_ttl_seconds,
                settings.jwt.refresh_reuse_grace_seconds,
            )
            await parked_sessions.park(
                device_id,
                outgoing.id,
                outgoing_issued.refresh_token,
                settings.jwt.refresh_idle_ttl_seconds,
            )
        except (HTTPException, ParkedSessionError):
            # The switch already succeeded; failing to park the outgoing account
            # only drops it out of the switcher, which is far better than
            # refusing a switch whose new tokens have already been minted.
            logger.warning(
                "account_park_outgoing_failed",
                "Switched accounts but could not park the previous one",
                failure_reason="park_outgoing_failed",
            )

    set_context(user_id=target.id, session_id=issued.session_id)
    issue_session_cookies(response, issued)
    issue_device_cookie(response, device_id)
    logger.info("account_switch_succeeded", "Switched the active account")
    return AuthResponse(**build_auth_response(target, issued.access_ttl))


@router.post("/accounts/{target_user_id}/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout_account(
    target_user_id: str,
    request: Request,
    response: Response,
    _: None = Depends(require_csrf_protection),
    ctx: AuthContext = Depends(require_session),
) -> Response:
    """Sign out of one specific account on this browser.

    Two cases, both ending with that account gone from the switcher:

    * **The active account** — identical to a plain logout: revoke its ``sid`` and
      clear the session cookies. The client is expected to have already switched
      away if it wants to stay signed in as someone else, because a switch needs a
      live session to authorise it.
    * **A parked account** — take its token, denylist the ``sid`` inside it, and
      drop the entry. Denylisting matters: discarding the stored copy alone would
      leave an exfiltrated copy usable until it expired.

    Same three factors as the rest of this group (active session + device cookie +
    CSRF), so one stolen cookie cannot sign a browser out of its other accounts.
    """
    require_multi_account()
    device_id = get_device_id(request)

    if target_user_id == ctx.user_id:
        revoked = await revoke_current_session(request)
        clear_session_cookies(response)
        if device_id:
            await parked_sessions.drop(device_id, target_user_id)
        logger.info(
            "account_logout_active",
            "Signed out of the active account",
            had_session=revoked is not None,
        )
        response.status_code = status.HTTP_204_NO_CONTENT
        return response

    if not device_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That account is not signed in on this browser.",
        )

    try:
        parked_token = await parked_sessions.take(device_id, target_user_id)
    except ParkedSessionError:
        # Already gone: a logout of something absent is a success, not an error.
        logger.info("account_logout_absent", "Parked account was already signed out")
        response.status_code = status.HTTP_204_NO_CONTENT
        return response

    try:
        parked_ctx = await resolve_parked_refresh(parked_token)
    except Exception:
        # Unverifiable (expired, revoked, key rotated) — the entry is already
        # deleted above, so the account is signed out either way.
        logger.info("account_logout_unverifiable", "Dropped an unusable parked session")
        response.status_code = status.HTTP_204_NO_CONTENT
        return response

    await logout_denylist.revoke(parked_ctx.id, settings.jwt.refresh_absolute_ttl_seconds)
    logger.info(
        "account_logout_parked",
        "Signed out of a parked account",
        target_user_id=target_user_id,
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/accounts/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all_accounts(
    request: Request,
    response: Response,
    _: None = Depends(require_csrf_protection),
    ctx: AuthContext = Depends(require_session),
) -> Response:
    """Sign out of every account on this browser.

    Exists so a shared machine is not left holding dormant logins: a plain logout
    ends only the active session, leaving the others switchable.
    """
    require_multi_account()
    device_id = get_device_id(request)
    removed = 0
    if device_id:
        # Dropping the entries discards the parked tokens themselves, so those
        # sessions become unusable even though their sids live inside the tokens.
        removed = len(await parked_sessions.clear(device_id))
    await revoke_current_session(request)
    clear_session_cookies(response)
    clear_device_cookie(response)
    logger.info(
        "logout_all_accounts_completed",
        "Signed out of every account on this device",
        parked_removed=removed,
        user_id=ctx.user_id,
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


# ---------------------------------------------------------------------------
# Microsoft Entra ID (OIDC) — federated sign-in alongside username/password
# ---------------------------------------------------------------------------
@router.get("/config", status_code=status.HTTP_200_OK)
async def auth_config() -> dict:
    """Public: which login methods the SPA should offer. No secrets — a single
    boolean so the login page knows whether to render the Microsoft button."""
    return {"oidcEnabled": settings.entra.enabled}


@router.get("/oidc/login", dependencies=[Depends(auth_rate_limit)])
async def oidc_login(request: Request, park: bool = False) -> RedirectResponse:
    """Begin the Entra auth-code flow — 302 the browser to Microsoft.

    ``?park=true`` is the "add another account" path. The intent cannot ride along
    with the redirect, so it is stored against the flow's single-use state and
    read back in the callback.
    """
    if not settings.entra.enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SSO is not enabled.")
    if park:
        await guard_add_account(request)
    try:
        auth_uri = await begin_login(oidc_redirect_uri(request), park=park)
    except EntraOIDCError as exc:
        logger.error(
            "oidc_login_start_failed",
            "Failed to start Microsoft sign-in",
            failure_reason="oidc_login_start_failed",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not start Microsoft sign-in. Please try again.",
        ) from exc
    return RedirectResponse(auth_uri, status_code=status.HTTP_302_FOUND)


@router.get("/oidc/callback")
async def oidc_callback(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Entra redirect target: validate the id_token, link/resolve the user, mint
    the same session cookies as password login, and land the browser in the SPA.

    On any failure we redirect back to the login screen with an ``sso`` reason
    query rather than leaking an error page — no session cookies are set."""
    if not settings.entra.enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SSO is not enabled.")

    def _deny(reason: str) -> RedirectResponse:
        return RedirectResponse(
            f"{settings.entra.login_error_redirect}?sso={reason}",
            status_code=status.HTTP_302_FOUND,
        )

    try:
        identity = await complete_login(dict(request.query_params))
    except EntraAccessDeniedError:
        # Authenticated fine, but not authorized (not in an allowed group) — a
        # deliberate access decision, not a transient failure.
        logger.warning("oidc_access_denied", "Microsoft user is not authorized to sign in", failure_reason="oidc_access_denied")
        return _deny("denied")
    except EntraOIDCError:
        logger.warning("oidc_callback_rejected", "Microsoft sign-in was rejected", failure_reason="oidc_callback_rejected")
        return _deny("failed")

    login_time = datetime.now(timezone.utc).replace(tzinfo=None)
    display_name = (identity.claims or {}).get("name")
    try:
        user = await upsert_user_from_identity(
            db,
            provider="entra",
            subject=identity.subject,
            username=identity.username,
            email=identity.email,
            metadata={
                "last_login_at": login_time,
                "full_name": display_name,
                "display_name": display_name,
            },
        )
    except IdentityConflictError:
        logger.warning("oidc_identity_conflict", "Could not link Microsoft identity to an existing account", failure_reason="oidc_identity_conflict")
        return _deny("conflict")

    if not user.is_active:
        logger.warning("oidc_user_inactive", "Authenticated Microsoft user is inactive", user_id=user.id, failure_reason="inactive_user")
        return _deny("disabled")

    user.last_login_at = login_time
    await db.commit()
    await db.refresh(user)

    # Honour "add another account" when that is how this flow started, so the
    # session already in the browser is parked instead of replaced. Goes through
    # the same finaliser as password login, so cookies, the device cookie and the
    # refresh-guard registration cannot drift between the two paths.
    park_previous = await consume_park_intent(request.query_params.get("state"))
    redirect = RedirectResponse(settings.entra.post_login_redirect, status_code=status.HTTP_302_FOUND)
    await finalize_login(request, redirect, user, park_previous=park_previous)
    logger.info(
        "oidc_login_succeeded",
        "User authenticated via Microsoft Entra",
        added_account=park_previous,
    )
    return redirect
