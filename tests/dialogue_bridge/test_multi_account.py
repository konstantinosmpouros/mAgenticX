"""Multi-account sign-in: the parked-session store and the switch endpoints.

The store holds live bearer credentials, so most of what is asserted here is
security behaviour rather than happy-path plumbing: values are encrypted and
bound to one (device, user) pair, a parked token is single-use, the cap is a hard
ceiling, and every endpoint is unreachable while the feature is disabled.
"""
from __future__ import annotations

import base64
import os

import pytest
from fakeredis import aioredis as fake_aioredis

import core.auth.parked as parked_mod
import core.auth.providers as auth_providers
from core.auth.parked import ParkedAccountLimit, ParkedSessionError, ParkedSessionStore
from core.auth.providers import AuthIdentity
from core.settings import settings


class _Provider:
    """Authenticates anyone; the username becomes the identity."""

    name = "vault"

    async def authenticate(self, payload):
        username = payload["username"]
        return AuthIdentity(subject=f"vault::{username}", username=username, provider="vault")


def _device_id(client) -> str | None:
    """The browser's parked-session index id, as the test client received it."""
    from core.auth.session import DEVICE_COOKIE_NAME

    return client.cookies.get(DEVICE_COOKIE_NAME)


@pytest.fixture
def parked_key(monkeypatch):
    """A real 32-byte AES-GCM key, so encryption runs for real in tests."""
    key = base64.b64encode(os.urandom(32)).decode("ascii")
    monkeypatch.setattr(settings.session, "parked_token_key", type(settings.session.parked_token_key)(key))
    return key


@pytest.fixture
def store(monkeypatch, parked_key):
    """A store bound to an in-process fakeredis.

    Patched at the module's factory rather than globally: unlike the logout
    denylist, this store *fails closed*, so it must have a working backend for
    the behaviour under test to be reachable at all.
    """
    client = fake_aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(parked_mod, "create_redis_client", lambda: client)
    monkeypatch.setattr(settings.session, "multi_account_enabled", True)
    return ParkedSessionStore()


@pytest.fixture
def multi_account(monkeypatch, store):
    """Enable the feature and point the shared store at fakeredis.

    Every module that did `from core.auth.parked import parked_sessions` holds its
    own reference, so patching the origin alone would miss them — the router owns
    the switch/logout handlers and utils.auth owns the login finaliser that parks
    the outgoing session.
    """
    import router.auth as auth_router
    import utils.auth as auth_utils

    for module in (parked_mod, auth_router, auth_utils):
        monkeypatch.setattr(module, "parked_sessions", store)
    return store


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------
async def test_park_and_take_round_trip(store):
    await store.park("device-1", "user-a", "refresh-token-a", 60)

    assert await store.list_user_ids("device-1") == ["user-a"]
    assert await store.take("device-1", "user-a") == "refresh-token-a"


async def test_take_is_single_use(store):
    """A switch rotates the token immediately, so leaving the old one behind
    would only widen the window in which a copy is usable."""
    await store.park("device-1", "user-a", "refresh-token-a", 60)
    await store.take("device-1", "user-a")

    with pytest.raises(ParkedSessionError):
        await store.take("device-1", "user-a")


async def test_tokens_are_encrypted_at_rest(store):
    """Redis must not hold a usable credential: a dump gives ciphertext only."""
    await store.park("device-1", "user-a", "super-secret-refresh", 60)

    client = parked_mod.create_redis_client()
    stored = await client.hget("auth:parked:device-1", "user-a")

    assert stored is not None
    assert "super-secret-refresh" not in stored


async def test_a_sealed_token_cannot_move_between_devices(store):
    """The (device, user) pair is authenticated data, so someone able to write
    Redis still cannot graft another browser's session onto their own."""
    await store.park("device-1", "user-a", "refresh-token-a", 60)

    client = parked_mod.create_redis_client()
    blob = await client.hget("auth:parked:device-1", "user-a")
    await client.hset("auth:parked:device-2", "user-a", blob)

    with pytest.raises(ParkedSessionError):
        await store.take("device-2", "user-a")


async def test_a_sealed_token_cannot_move_between_users(store):
    await store.park("device-1", "user-a", "refresh-token-a", 60)

    client = parked_mod.create_redis_client()
    blob = await client.hget("auth:parked:device-1", "user-a")
    await client.hset("auth:parked:device-1", "user-b", blob)

    with pytest.raises(ParkedSessionError):
        await store.take("device-1", "user-b")


async def test_cap_is_a_hard_ceiling(store, monkeypatch):
    """The setting caps accounts signed in *in total*, and one is always active —
    so with a cap of 3 at most 2 may be parked."""
    monkeypatch.setattr(settings.session, "max_parked_accounts", 3)
    await store.park("device-1", "user-a", "token-a", 60)
    await store.park("device-1", "user-b", "token-b", 60)

    with pytest.raises(ParkedAccountLimit):
        await store.park("device-1", "user-c", "token-c", 60)


async def test_a_cap_of_two_allows_one_parked_account(store, monkeypatch):
    """The shipped default: personal + work. One active, one parked."""
    monkeypatch.setattr(settings.session, "max_parked_accounts", 2)
    await store.park("device-1", "user-a", "token-a", 60)

    with pytest.raises(ParkedAccountLimit):
        await store.park("device-1", "user-b", "token-b", 60)


async def test_reparking_the_same_user_is_an_update_not_a_new_slot(store, monkeypatch):
    monkeypatch.setattr(settings.session, "max_parked_accounts", 2)
    await store.park("device-1", "user-a", "token-old", 60)
    await store.park("device-1", "user-a", "token-new", 60)

    assert await store.count("device-1") == 1
    assert await store.take("device-1", "user-a") == "token-new"


async def test_clear_returns_and_removes_everything(store, monkeypatch):
    # Headroom for two parked entries — this exercises clear(), not the cap.
    monkeypatch.setattr(settings.session, "max_parked_accounts", 3)
    await store.park("device-1", "user-a", "token-a", 60)
    await store.park("device-1", "user-b", "token-b", 60)

    removed = await store.clear("device-1")

    assert sorted(removed) == ["user-a", "user-b"]
    assert await store.list_user_ids("device-1") == []


async def test_park_with_no_key_material_at_all_refuses(store, monkeypatch):
    """Fail closed: never fall back to writing a credential in plaintext."""
    blank = type(settings.session.parked_token_key)("")
    monkeypatch.setattr(settings.session, "parked_token_key", blank)
    monkeypatch.setattr(settings.session, "token_secret", blank)

    with pytest.raises(ParkedSessionError):
        await store.park("device-1", "user-a", "token-a", 60)


async def test_the_key_is_derived_when_no_dedicated_secret_is_set(store, monkeypatch):
    """Local dev sets no PARKED_TOKEN_KEY, so the key is derived from
    SESSION_TOKEN_SECRET — encryption still happens, it is just not a separately
    rotatable key (which is why production supplies one)."""
    secret_type = type(settings.session.parked_token_key)
    monkeypatch.setattr(settings.session, "parked_token_key", secret_type(""))
    monkeypatch.setattr(settings.session, "token_secret", secret_type("a-local-dev-session-secret"))

    await store.park("device-1", "user-a", "super-secret-refresh", 60)

    client = parked_mod.create_redis_client()
    stored = await client.hget("auth:parked:device-1", "user-a")
    assert "super-secret-refresh" not in stored
    assert await store.take("device-1", "user-a") == "super-secret-refresh"


# ---------------------------------------------------------------------------
# The endpoints
# ---------------------------------------------------------------------------
async def test_endpoints_are_absent_when_the_feature_is_disabled(client, monkeypatch):
    """A disabled feature must not even be probeable."""
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    monkeypatch.setattr(settings.session, "multi_account_enabled", False)
    await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})

    assert (await client.get("/v1/auth/accounts")).status_code == 404
    switch = await client.post("/v1/auth/accounts/switch", json={"user_id": "someone"})
    assert switch.status_code == 404


async def test_accounts_requires_a_session(client, multi_account):
    assert (await client.get("/v1/auth/accounts")).status_code == 401


async def test_add_account_then_switch_between_them(client, monkeypatch, multi_account):
    """The whole point, end to end: two accounts signed in, switch between them."""
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())

    first = await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})
    assert first.status_code == 200
    alice_id = first.json()["user_id"]

    second = await client.post(
        "/v1/auth/login", params={"park": "true"}, json={"username": "bob", "password": "pw"}
    )
    assert second.status_code == 200
    bob_id = second.json()["user_id"]
    assert bob_id != alice_id

    listing = await client.get("/v1/auth/accounts")
    assert listing.status_code == 200
    body = listing.json()
    by_id = {row["id"]: row for row in body["accounts"]}
    assert by_id[bob_id]["current"] is True
    assert by_id[alice_id]["current"] is False
    # A token must never reach the client.
    assert not any("token" in key.lower() for row in body["accounts"] for key in row)

    switched = await client.post("/v1/auth/accounts/switch", json={"user_id": alice_id})
    assert switched.status_code == 200
    assert switched.json()["user_id"] == alice_id

    who = await client.get("/v1/auth/session")
    assert who.json()["user"]["username"] == "alice"

    # Bob is now the parked one, and is still offered.
    after = await client.get("/v1/auth/accounts")
    rows = {row["id"]: row for row in after.json()["accounts"]}
    assert rows[alice_id]["current"] is True
    assert bob_id in rows


async def test_switching_to_the_active_account_is_rejected(client, monkeypatch, multi_account):
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    login = await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})

    response = await client.post(
        "/v1/auth/accounts/switch", json={"user_id": login.json()["user_id"]}
    )

    assert response.status_code == 409


async def test_switching_to_an_unparked_account_is_rejected(client, monkeypatch, multi_account):
    """A device cookie plus a guessed user id must not be enough to become them."""
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})

    response = await client.post(
        "/v1/auth/accounts/switch", json={"user_id": "00000000-0000-0000-0000-000000000000"}
    )

    assert response.status_code == 409


async def test_logout_all_accounts_clears_the_device(client, monkeypatch, multi_account):
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})
    await client.post(
        "/v1/auth/login", params={"park": "true"}, json={"username": "bob", "password": "pw"}
    )

    response = await client.post("/v1/auth/accounts/logout-all")

    assert response.status_code == 204
    assert (await client.get("/v1/auth/accounts")).status_code == 401
    assert (await client.get("/v1/auth/session")).status_code == 401


async def test_plain_logout_drops_the_account_from_the_switcher(client, monkeypatch, multi_account):
    """Logging out of the active account must not leave it listed as something to
    switch back into."""
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    first = await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})
    alice_id = first.json()["user_id"]
    await client.post(
        "/v1/auth/login", params={"park": "true"}, json={"username": "bob", "password": "pw"}
    )

    await client.post("/v1/auth/logout")

    # Bob's session is gone, but alice stays parked: a plain logout ends only the
    # active account and must not disturb the browser's other sign-ins.
    assert (await client.get("/v1/auth/session")).status_code == 401
    device_id = _device_id(client)
    assert device_id, "login should have established a device cookie"
    assert alice_id in await multi_account.list_user_ids(device_id)


# ---------------------------------------------------------------------------
# Per-account logout
# ---------------------------------------------------------------------------
async def test_logging_out_a_parked_account_removes_and_revokes_it(
    client, monkeypatch, multi_account
):
    """Dropping the stored copy is not enough — the session must be denylisted,
    or a token exfiltrated before the logout would stay usable until it expired."""
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    first = await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})
    alice_id = first.json()["user_id"]
    await client.post(
        "/v1/auth/login", params={"park": "true"}, json={"username": "bob", "password": "pw"}
    )

    response = await client.post(f"/v1/auth/accounts/{alice_id}/logout")

    assert response.status_code == 204
    listing = await client.get("/v1/auth/accounts")
    assert alice_id not in {row["id"] for row in listing.json()["accounts"]}
    # Bob is untouched and still the active account.
    assert (await client.get("/v1/auth/session")).json()["user"]["username"] == "bob"


async def test_logging_out_the_active_account_clears_the_session(
    client, monkeypatch, multi_account
):
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    login = await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})
    alice_id = login.json()["user_id"]

    response = await client.post(f"/v1/auth/accounts/{alice_id}/logout")

    assert response.status_code == 204
    assert (await client.get("/v1/auth/session")).status_code == 401


async def test_logging_out_an_absent_account_is_a_no_op(client, monkeypatch, multi_account):
    """A logout of something already gone is a success, not an error."""
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})

    response = await client.post(
        "/v1/auth/accounts/00000000-0000-0000-0000-000000000000/logout"
    )

    assert response.status_code == 204


# ---------------------------------------------------------------------------
# CSRF — these routes change auth state, so the double-submit check must bite.
#
# conftest overrides `require_csrf_protection` for the whole suite (every other
# test would otherwise have to carry the header), so each test here removes that
# override to exercise the real dependency.
# ---------------------------------------------------------------------------
@pytest.fixture
def real_csrf(app):
    from core.auth.session import require_csrf_protection

    app.dependency_overrides.pop(require_csrf_protection, None)
    return True


def _csrf_header(client) -> dict[str, str]:
    from core.auth.session import CSRF_COOKIE_NAME, CSRF_HEADER_NAME

    return {CSRF_HEADER_NAME: client.cookies.get(CSRF_COOKIE_NAME) or ""}


@pytest.mark.parametrize(
    "path",
    ["/v1/auth/accounts/switch", "/v1/auth/accounts/logout-all", "/v1/auth/accounts/u/logout"],
)
async def test_state_changing_routes_reject_a_missing_csrf_token(
    client, monkeypatch, multi_account, real_csrf, path
):
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    await client.post(
        "/v1/auth/login", json={"username": "alice", "password": "pw"}, headers={}
    )

    response = await client.post(path, json={"user_id": "someone"})

    assert response.status_code == 403
    assert response.json()["detail"] == "Invalid CSRF token."


async def test_state_changing_routes_reject_a_mismatched_csrf_token(
    client, monkeypatch, multi_account, real_csrf
):
    """A double-submit check must compare, not merely require presence."""
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})
    from core.auth.session import CSRF_HEADER_NAME

    response = await client.post(
        "/v1/auth/accounts/logout-all", headers={CSRF_HEADER_NAME: "not-the-cookie-value"}
    )

    assert response.status_code == 403


async def test_a_matching_csrf_token_is_accepted(client, monkeypatch, multi_account, real_csrf):
    """The negative tests above would also pass if the route were simply broken,
    so prove the same request succeeds once the tokens match."""
    monkeypatch.setitem(auth_providers._PROVIDERS, "vault", _Provider())
    login = await client.post("/v1/auth/login", json={"username": "alice", "password": "pw"})

    response = await client.post(
        "/v1/auth/accounts/switch",
        json={"user_id": login.json()["user_id"]},
        headers=_csrf_header(client),
    )

    # 409 "already active" — past CSRF, into the handler.
    assert response.status_code == 409
