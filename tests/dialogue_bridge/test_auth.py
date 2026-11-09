"""Sign-in and session lifecycle, now that Microsoft Entra is the only way in.

Plan 29 Part A removed username/password login. These tests drive the real
OIDC callback — only Microsoft's half is stubbed, by the ``sso_login`` fixture —
and pin the three things the removal must not break or weaken:

- **the door is shut:** there is no password route left to find;
- **nothing is lost:** sign-in, refresh, logout and the session still work;
- **no merge by email:** a sign-in resolves its account by the Entra ``oid``
  only, so a matching email can never hand over someone else's account.
"""
from __future__ import annotations

import pytest
from fastapi.dependencies.utils import get_dependant
from pydantic import ValidationError
from sqlalchemy import select

import core.auth.oidc as oidc_module_for_tests
import router.auth as auth_router_module
from core.auth.oidc import EntraAccessDeniedError, EntraOIDCError
from core.auth.providers import AuthIdentity
from core.auth.session import OIDC_BINDING_COOKIE_NAME, require_current_user
from core.database import UserTable, get_db
from core.settings import EntraSettings, Settings


def _access_cookie(client) -> str | None:
    return client.cookies.get("__Host-mx_session") or client.cookies.get("mx_session")


def _refresh_cookie(client) -> str | None:
    return client.cookies.get("__Host-mx_refresh") or client.cookies.get("mx_refresh")


# ---------------------------------------------------------------------------
# The door is shut
# ---------------------------------------------------------------------------
async def test_the_password_login_route_no_longer_exists(client):
    response = await client.post("/v1/auth/login", json={"username": "alice", "password": "secret"})

    assert response.status_code == 404
    assert _access_cookie(client) is None


async def test_the_login_config_still_offers_microsoft(client):
    # Kept for SPAs from before this release, which read it to show the button.
    response = await client.get("/v1/auth/config")

    assert response.status_code == 200
    assert response.json() == {"oidcEnabled": True}


def test_the_bridge_refuses_to_boot_without_entra():
    # With Entra unconfigured the login page would have no way in at all.
    entra = EntraSettings(_env_file=None, ENTRA_TENANT_ID=None)
    assert entra.enabled is False

    with pytest.raises(ValidationError, match="only login method"):
        Settings(entra=entra)


# ---------------------------------------------------------------------------
# Nothing is lost
# ---------------------------------------------------------------------------
async def test_microsoft_sign_in_creates_a_session(client, sso_login):
    response = await sso_login("alice", email="alice@example.com")

    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert _access_cookie(client) and _refresh_cookie(client)

    session = await client.get("/v1/auth/session")
    assert session.status_code == 200
    user = session.json()["user"]
    assert user["username"] == "alice"
    assert user["email"] == "alice@example.com"
    assert user["displayName"] == "Alice"


async def test_refresh_rotates_the_session_and_logout_ends_it(client, sso_login):
    await sso_login("carol")
    access_before, refresh_before = _access_cookie(client), _refresh_cookie(client)

    refreshed = await client.post("/v1/auth/session/refresh")

    assert refreshed.status_code == 200
    assert _access_cookie(client) != access_before
    assert _refresh_cookie(client) != refresh_before

    assert (await client.post("/v1/auth/logout")).status_code == 204
    assert (await client.get("/v1/auth/session")).status_code == 401


async def test_the_session_requires_authentication(client):
    response = await client.get("/v1/auth/session")

    assert response.status_code == 401
    assert response.json()["detail"] == "Authentication required."


def test_authenticating_a_request_never_opens_a_database_session():
    # R1, structurally: the dependency every authenticated endpoint builds on has
    # no path to the database. Verification is a signature check plus Redis.
    def dependency_calls(dependant):
        for sub in dependant.dependencies:
            yield sub.call
            yield from dependency_calls(sub)

    calls = set(dependency_calls(get_dependant(path="/", call=require_current_user)))
    assert get_db not in calls


# ---------------------------------------------------------------------------
# Refusals land back on the login page, with no session
# ---------------------------------------------------------------------------
async def test_a_user_outside_the_allowed_group_is_refused(client, monkeypatch, bind_sign_in):
    async def denied(_auth_response):
        raise EntraAccessDeniedError("not in an allowed group")

    monkeypatch.setattr(auth_router_module, "complete_login", denied)
    await bind_sign_in("s")
    response = await client.get("/v1/auth/oidc/callback", params={"state": "s", "code": "c"})

    assert response.status_code == 302
    assert response.headers["location"] == "/login?sso=denied"
    assert _access_cookie(client) is None


async def test_a_refused_add_account_returns_to_the_add_account_screen(client, sso_login, monkeypatch, bind_sign_in):
    # Regression: the refusal used to drop the add-account context. The login
    # page then restored the still-valid first session and reloaded into the app,
    # hiding the reason — "add account" looked like it silently did nothing.
    await sso_login("alice")

    async def denied(_auth_response):
        raise EntraAccessDeniedError("not in an allowed group")

    async def was_add_account(_state):
        return True

    monkeypatch.setattr(auth_router_module, "complete_login", denied)
    monkeypatch.setattr(auth_router_module, "consume_park_intent", was_add_account)
    await bind_sign_in("s")
    response = await client.get("/v1/auth/oidc/callback", params={"state": "s", "code": "c"})

    assert response.headers["location"] == "/login?sso=denied&add=1"
    # The first account is untouched.
    assert (await client.get("/v1/auth/session")).json()["user"]["username"] == "alice"


async def test_a_plain_refusal_does_not_claim_add_account_mode(client, monkeypatch, bind_sign_in):
    async def denied(_auth_response):
        raise EntraAccessDeniedError("not in an allowed group")

    async def not_add_account(_state):
        return False

    monkeypatch.setattr(auth_router_module, "complete_login", denied)
    monkeypatch.setattr(auth_router_module, "consume_park_intent", not_add_account)
    await bind_sign_in("s")
    response = await client.get("/v1/auth/oidc/callback", params={"state": "s", "code": "c"})

    assert response.headers["location"] == "/login?sso=denied"


async def test_a_failed_or_replayed_callback_is_refused(client, monkeypatch, bind_sign_in):
    async def failed(_auth_response):
        raise EntraOIDCError("Unknown or expired authorization state.")

    monkeypatch.setattr(auth_router_module, "complete_login", failed)
    await bind_sign_in("s")
    response = await client.get("/v1/auth/oidc/callback", params={"state": "s", "code": "c"})

    assert response.headers["location"] == "/login?sso=failed"
    assert _access_cookie(client) is None


async def test_a_disabled_account_is_refused(client, sso_login, session_factory):
    await sso_login("dave")
    await client.post("/v1/auth/logout")
    async with session_factory() as session:
        user = await session.scalar(select(UserTable).where(UserTable.username == "dave"))
        user.is_active = False
        await session.commit()

    response = await sso_login("dave")

    assert response.headers["location"] == "/login?sso=disabled"
    assert (await client.get("/v1/auth/session")).status_code == 401


# ---------------------------------------------------------------------------
# Accounts are resolved by oid — never merged by email
# ---------------------------------------------------------------------------
async def test_a_returning_user_is_resolved_by_oid_even_if_their_email_changed(client, sso_login):
    await sso_login("erin", subject="oid-erin", email="erin@old.example.com")
    first_id = (await client.get("/v1/auth/session")).json()["user_id"]
    await client.post("/v1/auth/logout")

    # Entra lets a user's email and username change; the oid does not.
    await sso_login("erin.renamed", subject="oid-erin", email="erin@new.example.com")

    assert (await client.get("/v1/auth/session")).json()["user_id"] == first_id


async def test_a_matching_email_never_hands_over_another_account(client, sso_login, session_factory):
    # An account that has never signed in with Microsoft — a Vault-era row that
    # missed linking, or anyone else's — holds this email. A new oid arriving
    # with the same email is refused, not attached to it.
    async with session_factory() as session:
        session.add(UserTable(username="frank-legacy", email="frank@example.com", vault_user_id="vault-frank"))
        await session.commit()

    response = await sso_login("frank", subject="oid-attacker", email="FRANK@example.com")

    assert response.headers["location"] == "/login?sso=conflict"
    assert _access_cookie(client) is None
    async with session_factory() as session:
        legacy = await session.scalar(select(UserTable).where(UserTable.username == "frank-legacy"))
        assert legacy.oidc_subject is None
        assert (await session.scalar(select(UserTable).where(UserTable.oidc_subject == "oid-attacker"))) is None


async def test_a_username_collision_is_refused_not_a_server_error(client, sso_login, session_factory):
    async with session_factory() as session:
        session.add(UserTable(username="grace", email="someone-else@example.com"))
        await session.commit()

    response = await sso_login("grace", subject="oid-grace", email="grace@example.com")

    assert response.status_code == 302
    assert response.headers["location"] == "/login?sso=conflict"


async def test_a_linked_account_keeps_its_history_row(client, sso_login, session_factory):
    # What Phase A1 produces: a Vault-era row that already carries its oid. It is
    # found by oid, so the same row — and everything bound to it — is used.
    async with session_factory() as session:
        row = UserTable(
            username="heidi",
            email="heidi@example.com",
            vault_user_id="vault-heidi",
            oidc_subject="oid-heidi",
            auth_providers="entra,vault",
        )
        session.add(row)
        await session.commit()
        row_id = row.id

    await sso_login("heidi@example.com", subject="oid-heidi", email="heidi@example.com")

    assert (await client.get("/v1/auth/session")).json()["user_id"] == row_id


# ---------------------------------------------------------------------------
# Login CSRF: a sign-in only completes in the browser that started it
# ---------------------------------------------------------------------------
def _signed_in_as(username: str):
    async def complete_login(_auth_response):
        return AuthIdentity(subject=f"oid::{username}", username=username, provider="entra")

    return complete_login


async def test_starting_a_sign_in_binds_it_to_this_browser(client, monkeypatch):
    seen = {}

    async def begin_login(_redirect_uri, *, binding, park=False, reauth_user_id=None):
        seen["binding"] = binding
        return "https://login.example/authorize"

    monkeypatch.setattr(auth_router_module, "begin_login", begin_login)
    first = await client.get("/v1/auth/oidc/login")
    assert first.status_code == 302
    cookie = first.headers["set-cookie"]
    assert cookie.startswith(f"{OIDC_BINDING_COOKIE_NAME}={seen['binding']}")
    assert "httponly" in cookie.lower() and "samesite=lax" in cookie.lower()
    assert len(seen["binding"]) >= 32

    # A second tab reuses this browser's binding, so both callbacks match.
    second_binding = seen["binding"]
    await client.get("/v1/auth/oidc/login")
    assert seen["binding"] == second_binding


async def test_a_callback_from_a_browser_that_did_not_start_the_sign_in_is_refused(client, monkeypatch):
    # The attacker's own half-finished sign-in, its link opened by the victim:
    # the state is real and unused, but the victim's browser has no binding.
    await oidc_module_for_tests._redis.set(
        f"{oidc_module_for_tests._BIND_KEY_PREFIX}attacker-state",
        oidc_module_for_tests._binding_digest("a" * 43),
    )
    redeemed = []

    async def complete_login(auth_response):
        redeemed.append(auth_response)
        return AuthIdentity(subject="oid::mallory", username="mallory", provider="entra")

    monkeypatch.setattr(auth_router_module, "complete_login", complete_login)
    response = await client.get("/v1/auth/oidc/callback", params={"state": "attacker-state", "code": "c"})

    assert response.headers["location"] == "/login?sso=failed"
    assert _access_cookie(client) is None
    assert redeemed == []  # refused before the code is redeemed


async def test_a_wrong_or_reused_binding_is_refused(client, bind_sign_in, monkeypatch):
    monkeypatch.setattr(auth_router_module, "complete_login", _signed_in_as("mallory"))
    await bind_sign_in("st-1", binding="a" * 43)
    client.cookies.set(OIDC_BINDING_COOKIE_NAME, "z" * 43)  # another browser's binding
    response = await client.get("/v1/auth/oidc/callback", params={"state": "st-1", "code": "c"})
    assert response.headers["location"] == "/login?sso=failed"

    # Single use: the right binding cannot retry a state already tried.
    client.cookies.set(OIDC_BINDING_COOKIE_NAME, "a" * 43)
    response = await client.get("/v1/auth/oidc/callback", params={"state": "st-1", "code": "c"})
    assert response.headers["location"] == "/login?sso=failed"
    assert _access_cookie(client) is None


async def test_a_bound_sign_in_completes_and_spends_its_binding(client, bind_sign_in, monkeypatch):
    monkeypatch.setattr(auth_router_module, "complete_login", _signed_in_as("alice"))
    await bind_sign_in("st-2")
    response = await client.get("/v1/auth/oidc/callback", params={"state": "st-2", "code": "c"})

    assert response.status_code == 302 and response.headers["location"] == "/"
    assert _access_cookie(client) is not None
    # The binding is spent: the callback tells the browser to drop it.
    cleared = [
        header
        for header in response.headers.get_list("set-cookie")
        if header.startswith(f"{OIDC_BINDING_COOKIE_NAME}=")
    ]
    assert cleared and "max-age=0" in cleared[0].lower()


async def test_the_binding_check_fails_closed_without_redis(monkeypatch):
    async def broken():
        raise ConnectionError("redis down")

    monkeypatch.setattr(oidc_module_for_tests, "_get_redis", broken)
    assert await oidc_module_for_tests.consume_login_binding("s", "a" * 43) is False
    assert await oidc_module_for_tests.consume_login_binding(None, "a" * 43) is False
