from __future__ import annotations

import core.auth.providers as auth_providers
from core.auth.providers import AuthIdentity
from core.auth.vault import VaultAuthError


class _SuccessfulProvider:
    name = "vault"

    async def authenticate(self, payload):
        username = payload["username"]
        return AuthIdentity(subject=f"vault::{username}", username=username, provider="vault")


class _RejectingProvider:
    name = "vault"

    async def authenticate(self, payload):
        raise VaultAuthError("bad credentials", status_code=401)


async def test_login_creates_session_and_session_endpoint_returns_user(client, monkeypatch):
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _SuccessfulProvider())

    login_response = await client.post(
        "/v1/auth/login",
        json={"username": "alice", "password": "secret"},
    )

    assert login_response.status_code == 200
    payload = login_response.json()
    assert payload["authenticated"] is True
    assert payload["user"]["username"] == "alice"
    assert payload["user_id"]

    session_response = await client.get("/v1/auth/session")
    assert session_response.status_code == 200
    assert session_response.json()["user"]["username"] == "alice"


async def test_login_invalid_credentials_returns_401(client, monkeypatch):
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _RejectingProvider())

    response = await client.post(
        "/v1/auth/login",
        json={"username": "bob", "password": "wrong"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid username or password."


async def test_refresh_rotates_session_and_logout_revokes_it(client, monkeypatch):
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _SuccessfulProvider())

    login_response = await client.post(
        "/v1/auth/login",
        json={"username": "carol", "password": "secret"},
    )
    access_cookie_before = client.cookies.get("__Host-mx_session") or client.cookies.get("mx_session")
    refresh_cookie_before = client.cookies.get("__Host-mx_refresh") or client.cookies.get("mx_refresh")

    assert login_response.status_code == 200

    refresh_response = await client.post("/v1/auth/session/refresh")
    access_cookie_after = client.cookies.get("__Host-mx_session") or client.cookies.get("mx_session")
    refresh_cookie_after = client.cookies.get("__Host-mx_refresh") or client.cookies.get("mx_refresh")

    assert refresh_response.status_code == 200
    assert access_cookie_before != access_cookie_after
    assert refresh_cookie_before != refresh_cookie_after

    logout_response = await client.post("/v1/auth/logout")
    assert logout_response.status_code == 204

    session_response = await client.get("/v1/auth/session")
    assert session_response.status_code == 401


async def test_session_requires_authentication(client):
    response = await client.get("/v1/auth/session")

    assert response.status_code == 401
    assert response.json()["detail"] == "Authentication required."
