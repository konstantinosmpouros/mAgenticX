"""Log out of all devices — the watermark that retires every session at once.

Auth is a stateless JWT verified by signature, so there is no session row to
delete and no `sid -> user` index to iterate. Instead `users.sessions_revoked_at`
records an instant, and every token whose `iat` predates it is refused.

Everything here is a property that fails *silently* when it breaks:

* a token that should have died keeps working (the revoke did nothing), or
* a token that should live gets rejected (the user is locked out of their own
  account, permanently, because re-login would be rejected too).

Neither raises. Both are one comparison away from each other.
"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from core.auth.session import is_stale
from utils.auth import revocation_watermark

NOW = int(datetime(2026, 9, 18, 12, 0, tzinfo=UTC).timestamp())


def _claims(iat: int) -> dict:
    return {"iat": iat, "sub": "u1", "sid": "s1"}


# ---------------------------------------------------------------------------
# The comparison itself
# ---------------------------------------------------------------------------
def test_a_token_minted_before_the_revoke_is_stale():
    assert is_stale(_claims(NOW - 1), NOW) is True


def test_a_token_minted_after_the_revoke_survives():
    assert is_stale(_claims(NOW + 1), NOW) is False


def test_a_token_minted_in_the_same_second_survives():
    """Strictly `<`, and the boundary is load-bearing in the user's favour.

    Signing back in immediately after "log out everywhere" can land in the same
    second as the watermark. If that token were rejected, so would its
    replacement be, and the account would be unreachable forever.
    """
    assert is_stale(_claims(NOW), NOW) is False


def test_no_watermark_means_nothing_is_stale():
    # The overwhelmingly common case: a user who has never used the feature.
    assert is_stale(_claims(NOW - 10_000), None) is False


def test_leeway_is_not_applied_to_the_watermark():
    """Token verification allows `leeway_seconds` on exp/iat to absorb clock
    skew. Applying it here would let a token minted seconds before the revoke
    survive the revoke — the exact thing the button exists to prevent."""
    a_few_seconds_before = NOW - 3
    assert is_stale(_claims(a_few_seconds_before), NOW) is True


def test_a_token_with_no_usable_iat_is_refused():
    # `verify` requires the claim, so reaching here means a malformed token.
    # It cannot be placed relative to the watermark, so it must not be trusted.
    assert is_stale({"sub": "u1"}, NOW) is True
    assert is_stale({"iat": "not-an-int"}, NOW) is True


def test_a_malformed_token_without_a_watermark_is_still_fine():
    # No revoke has happened, so there is nothing for it to be stale against;
    # the ordinary signature path already accepted it.
    assert is_stale({"sub": "u1"}, None) is False


# ---------------------------------------------------------------------------
# Reading the durable column
# ---------------------------------------------------------------------------
class _Row:
    def __init__(self, at):
        self.sessions_revoked_at = at


def test_a_naive_column_value_is_read_as_utc():
    """The column is `timestamp without time zone` and SQLAlchemy hands back a
    naive datetime. Interpreting it as local time would shift the watermark by
    the host's offset — hours of tokens wrongly kept or wrongly killed."""
    naive = datetime(2026, 9, 18, 12, 0)
    assert revocation_watermark(_Row(naive)) == NOW


def test_an_aware_column_value_round_trips():
    aware = datetime(2026, 9, 18, 12, 0, tzinfo=UTC)
    assert revocation_watermark(_Row(aware)) == NOW


def test_a_user_who_never_revoked_has_no_watermark():
    assert revocation_watermark(_Row(None)) is None


def test_a_missing_user_has_no_watermark():
    # The refresh path calls this before it has proven the user exists.
    assert revocation_watermark(None) is None


# ---------------------------------------------------------------------------
# End to end, over the real endpoint
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_revoking_writes_the_durable_watermark(session_factory, seeded_user):
    """Postgres is the source of truth: it is what the refresh path reads, so a
    revoke that only reached Redis would evaporate on the next cache flush."""
    from core.database import UserTable
    from utils.auth import revoke_all_sessions

    async with session_factory() as session:
        before = (await session.get(UserTable, seeded_user.id)).sessions_revoked_at
        assert before is None

        at = await revoke_all_sessions(session, seeded_user.id)

    async with session_factory() as session:
        stored = (await session.get(UserTable, seeded_user.id)).sessions_revoked_at
    assert stored is not None
    # Same instant the caller was told about — the UI reports what was written.
    assert abs((stored - at).total_seconds()) < 1


@pytest.mark.asyncio
async def test_revoking_one_user_does_not_touch_another(session_factory, seeded_user):
    """The watermark is per-user. A shared device can hold several accounts, and
    revoking one must leave the others signed in."""
    from core.database import UserTable
    from utils.auth import revoke_all_sessions

    async with session_factory() as session:
        other = UserTable(username="someone-else", is_active=True)
        session.add(other)
        await session.commit()
        other_id = other.id

        await revoke_all_sessions(session, seeded_user.id)

    async with session_factory() as session:
        assert (await session.get(UserTable, other_id)).sessions_revoked_at is None


@pytest.mark.asyncio
async def test_a_second_revoke_moves_the_watermark_forward(session_factory, seeded_user):
    # Pressing it twice must not be a no-op: tokens minted between the two
    # presses have to die on the second.
    from core.database import UserTable
    from utils.auth import revoke_all_sessions

    async with session_factory() as session:
        first = await revoke_all_sessions(session, seeded_user.id)
    async with session_factory() as session:
        second = await revoke_all_sessions(session, seeded_user.id)
    assert second >= first

    async with session_factory() as session:
        stored = (await session.get(UserTable, seeded_user.id)).sessions_revoked_at
    assert abs((stored - second).total_seconds()) < 1


@pytest.mark.asyncio
async def test_a_token_from_before_the_revoke_is_rejected_on_refresh(
    session_factory, seeded_user
):
    """The whole point, assembled: a session that predates the revoke cannot be
    renewed, which is what bounds a stolen token to its access lifetime."""
    from core.database import UserTable
    from utils.auth import revoke_all_sessions

    issued_before = int(datetime.now(UTC).timestamp()) - 60
    async with session_factory() as session:
        await revoke_all_sessions(session, seeded_user.id)
        user = await session.get(UserTable, seeded_user.id)
        watermark = revocation_watermark(user)

    assert is_stale({"iat": issued_before}, watermark) is True
    # And a session minted after it is honoured, so re-login works.
    issued_after = int(datetime.now(UTC).timestamp()) + 5
    assert is_stale({"iat": issued_after}, watermark) is False


@pytest.mark.asyncio
async def test_the_endpoint_requires_a_session(client):
    # Unauthenticated callers must not be able to revoke anybody's sessions.
    response = await client.post("/v1/auth/sessions/revoke-all")
    assert response.status_code in (401, 403)


def test_the_two_logout_all_routes_are_not_the_same_thing(app):
    """`/accounts/logout-all` ends every account on this browser;
    `/sessions/revoke-all` ends every browser for this account. Both exist, and
    conflating them in a UI would silently do the wrong one."""
    paths = {route.path for route in app.routes if hasattr(route, "path")}
    assert "/v1/auth/sessions/revoke-all" in paths
    assert "/v1/auth/accounts/logout-all" in paths

