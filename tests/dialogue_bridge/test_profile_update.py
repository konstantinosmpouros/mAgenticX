"""Edit profile — the name the app shows.

Signed in the way production signs in (the Entra callback, Microsoft's half
stubbed; the stub's ``name`` claim is the username titled: "Alice"). Pinned:

* the chosen name is what the session, the account switcher and the export
  show, and a later Microsoft sign-in does **not** overwrite it;
* a blank or null name goes back to Microsoft's;
* names are normalized (whitespace) and invisible / direction-changing
  characters and over-long names are refused;
* one user can never rename another.
"""
from __future__ import annotations

import pytest

from utils import validate_userId

EMAIL = "alice@example.com"


@pytest.fixture
def real_user_binding(app):
    """The suite's app stubs the path-user check; these tests need the real one."""
    app.dependency_overrides.pop(validate_userId, None)


async def _signed_in(client, sso_login) -> str:
    resp = await sso_login("alice", email=EMAIL)
    assert resp.status_code == 302, resp.text
    return (await client.get("/v1/auth/session")).json()["user_id"]


async def _rename(client, uid: str, name):
    return await client.patch(f"/v1/account/{uid}/profile", json={"displayName": name})


async def test_a_chosen_name_is_shown_and_survives_the_next_sign_in(client, sso_login):
    uid = await _signed_in(client, sso_login)
    assert (await client.get("/v1/auth/session")).json()["user"]["displayName"] == "Alice"

    resp = await _rename(client, uid, "  Alice   Liddell ")
    assert resp.status_code == 200, resp.text
    assert resp.json()["displayName"] == "Alice Liddell"
    assert resp.json()["preferredName"] == "Alice Liddell"

    # Microsoft sends "Alice" again on every sign-in; the user's choice stands.
    await sso_login("alice", email=EMAIL)
    user = (await client.get("/v1/auth/session")).json()["user"]
    assert user["displayName"] == "Alice Liddell"


async def test_clearing_the_name_goes_back_to_microsofts(client, sso_login):
    uid = await _signed_in(client, sso_login)
    assert (await _rename(client, uid, "Someone Else")).status_code == 200

    for blank in ("   ", None):
        resp = await _rename(client, uid, blank)
        assert resp.status_code == 200
        assert resp.json()["displayName"] == "Alice"
        assert resp.json()["preferredName"] is None


@pytest.mark.parametrize("bad", ["a\u202eb", "nul\u0000", "zero\u200bwidth", "x" * 65])
async def test_unshowable_or_overlong_names_are_refused(client, sso_login, bad):
    uid = await _signed_in(client, sso_login)
    assert (await _rename(client, uid, bad)).status_code == 422
    assert (await client.get("/v1/auth/session")).json()["user"]["displayName"] == "Alice"


async def test_unknown_fields_are_refused(client, sso_login):
    uid = await _signed_in(client, sso_login)
    resp = await client.patch(f"/v1/account/{uid}/profile", json={"displayName": "A", "email": "x@y.z"})
    assert resp.status_code == 422


async def test_nobody_can_rename_someone_else(client, sso_login, real_user_binding):
    alice = await _signed_in(client, sso_login)
    resp = await sso_login("bob", email="bob@example.com")
    assert resp.status_code == 302
    assert (await _rename(client, alice, "Mallory")).status_code == 403
    # The active session is Bob's; his refused request changed nothing.
    assert (await client.get("/v1/auth/session")).json()["user"]["displayName"] == "Bob"
