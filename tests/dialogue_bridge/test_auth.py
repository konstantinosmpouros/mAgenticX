from __future__ import annotations

from dataclasses import dataclass

from router import auth as auth_router
from core.auth_client import VaultAuthError


@dataclass
class _FakeVaultAuthResult:
    vault_user_id: str
    username: str
    client_token_ttl: int | None
    client_token_renewable: bool


class _SuccessfulVaultAuthenticator:
    async def authenticate(self, username: str, password: str):
        return _FakeVaultAuthResult(
            vault_user_id=f"vault::{username}",
            username=username,
            client_token_ttl=300,
            client_token_renewable=False,
        )


class _RejectingVaultAuthenticator:
    async def authenticate(self, username: str, password: str):
        raise VaultAuthError("bad credentials", status_code=401)


async def test_login_creates_session_and_session_endpoint_returns_user(client, monkeypatch):
    monkeypatch.setattr(auth_router, "_vault_authenticator", _SuccessfulVaultAuthenticator())

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
    monkeypatch.setattr(auth_router, "_vault_authenticator", _RejectingVaultAuthenticator())

    response = await client.post(
        "/v1/auth/login",
        json={"username": "bob", "password": "wrong"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid username or password."


async def test_refresh_rotates_session_and_logout_revokes_it(client, monkeypatch):
    monkeypatch.setattr(auth_router, "_vault_authenticator", _SuccessfulVaultAuthenticator())

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
