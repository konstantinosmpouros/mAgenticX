"""Account deletion (plan 32) — requesting, the grace period, cancelling.

Signed in the way production signs in (the Entra callback, Microsoft's half
stubbed), so the cookies, tokens and gates are the real ones. Pinned:

* a request needs a **recent** sign-in and the account's email typed back, both
  checked on the server; it schedules the purge and ends every session;
* a re-authentication must be the same Microsoft account, and never creates or
  switches one;
* signing in during the grace period yields a **frozen** session — only status,
  cancel, export and leaving work — and cancelling plus a refresh thaws it;
* the scheduler and public share links skip a pending account without changing it;
* a run, or a share import, on someone else's private agent is refused.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

import router.auth as auth_router_module
import utils.account_deletion as account_deletion
import utils.data_export as data_export
from core.auth.session import (
    AuthContext,
    PENDING_DELETION_DETAIL,
    require_current_user,
    require_current_user_even_if_pending,
)
from core.auth.tokens import mint_tokens, verify
from core.database import (
    AccountDeletionTable,
    AgentTable,
    ConversationShareTable,
    ConversationTable,
    ScheduledTaskTable,
    UserTable,
)
from core.logging import hash_identifier
from schema import MessageIn
from utils import validate_userId, validate_userId_even_if_pending
from utils.inference_runs import create_inference_run_record
from utils.scheduled_tasks import claim_due_tasks
from utils.shared_conv import create_conversation_from_share_record, load_active_share

EMAIL = "alice@example.com"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def _signed_in(client, sso_login, **kw) -> str:
    resp = await sso_login("alice", email=EMAIL, **kw)
    assert resp.status_code == 302, resp.text
    me = await client.get("/v1/auth/session")
    assert me.status_code == 200
    return me.json()["user_id"]


async def _deletion_row(session_factory, user_id):
    async with session_factory() as s:
        return (await s.execute(select(AccountDeletionTable).where(AccountDeletionTable.user_id == user_id))).scalar_one_or_none()


# -- tokens and the gate --------------------------------------------------------


@pytest.mark.asyncio
async def test_tokens_carry_the_sign_in_time_and_the_pending_marker():
    issued = await mint_tokens("u1", pending_deletion=True)
    access = await verify(issued.access_token, "access")
    assert access["pdl"] is True and isinstance(access["lat"], int)
    plain = await verify((await mint_tokens("u1")).access_token, "access")
    assert "pdl" not in plain


@pytest.mark.asyncio
async def test_a_pending_session_is_refused_everywhere_but_the_allowlist():
    ctx = AuthContext(id="s", user_id="u1", is_active=True, expires_at=_now(), pending_deletion=True)
    with pytest.raises(HTTPException) as exc:
        await require_current_user(ctx)
    assert exc.value.status_code == 403 and exc.value.detail == PENDING_DELETION_DETAIL
    assert (await require_current_user_even_if_pending(ctx)).id == "u1"


# -- requesting -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_after_a_fresh_sign_in(client, sso_login):
    uid = await _signed_in(client, sso_login)
    body = (await client.get(f"/v1/account/{uid}/deletion")).json()
    assert body["pending"] is False and body["reauthRequired"] is False
    assert body["confirmWith"] == EMAIL and body["graceDays"] == 14


@pytest.mark.asyncio
async def test_a_request_needs_a_recent_sign_in(client, sso_login, session_factory, monkeypatch):
    uid = await _signed_in(client, sso_login)
    later = time.time() + 11 * 60                       # past the 10-minute window
    monkeypatch.setattr(account_deletion.time, "time", lambda: later)

    resp = await client.post(f"/v1/account/{uid}/deletion", json={"confirmEmail": EMAIL})

    assert resp.status_code == 403 and resp.json()["detail"] == account_deletion.REAUTH_REQUIRED_DETAIL
    assert await _deletion_row(session_factory, uid) is None


@pytest.mark.asyncio
async def test_a_request_needs_the_account_typed_back(client, sso_login, session_factory):
    uid = await _signed_in(client, sso_login)
    resp = await client.post(f"/v1/account/{uid}/deletion", json={"confirmEmail": "someone@else.com"})
    assert resp.status_code == 400
    assert await _deletion_row(session_factory, uid) is None


@pytest.mark.asyncio
async def test_a_request_schedules_the_purge_and_ends_every_session(client, sso_login, session_factory):
    uid = await _signed_in(client, sso_login)

    resp = await client.post(f"/v1/account/{uid}/deletion", json={"confirmEmail": "  Alice@Example.com "})

    assert resp.status_code == 202 and resp.json()["pending"] is True
    row = await _deletion_row(session_factory, uid)
    assert row is not None and row.user_ref == hash_identifier(uid)
    assert timedelta(days=13, hours=23) < row.scheduled_for - row.requested_at <= timedelta(days=14)
    async with session_factory() as s:
        assert (await s.get(UserTable, uid)).sessions_revoked_at is not None
    # This browser's cookies are cleared in the same response.
    assert any("max-age=0" in c.lower() or "expires=thu, 01 jan 1970" in c.lower()
               for c in resp.headers.get_list("set-cookie"))


# -- the grace period ------------------------------------------------------------


@pytest.mark.asyncio
async def test_signing_in_during_grace_gives_a_frozen_session_and_cancel_thaws_it(
    client, sso_login, session_factory, app, monkeypatch
):
    monkeypatch.setattr(data_export, "SessionLocal", session_factory)   # export status reads the test DB
    uid = await _signed_in(client, sso_login)
    assert (await client.post(f"/v1/account/{uid}/deletion", json={"confirmEmail": EMAIL})).status_code == 202
    # The real scope + pending checks, not the fixture's stand-ins.
    app.dependency_overrides.pop(validate_userId, None)
    app.dependency_overrides.pop(validate_userId_even_if_pending, None)

    await _signed_in(client, sso_login)                         # sign in again, during grace
    me = (await client.get("/v1/auth/session")).json()
    assert me["pendingDeletion"]["scheduledFor"] and me["pendingDeletion"]["inProgress"] is False
    assert (await client.get(f"/v1/preferences/{uid}")).status_code == 403          # frozen
    assert (await client.get(f"/v1/export/{uid}/status")).status_code == 200        # export stays open
    assert (await client.get(f"/v1/account/{uid}/deletion")).json()["pending"] is True

    cancelled = await client.delete(f"/v1/account/{uid}/deletion")
    assert cancelled.status_code == 200 and cancelled.json()["pending"] is False
    assert (await _deletion_row(session_factory, uid)).cancelled_at is not None
    refreshed = await client.post("/v1/auth/session/refresh")
    assert refreshed.status_code == 200 and refreshed.json()["pendingDeletion"] is None
    assert (await client.get(f"/v1/preferences/{uid}")).status_code == 200          # thawed


@pytest.mark.asyncio
async def test_a_purge_already_running_cannot_be_cancelled(client, sso_login, session_factory):
    uid = await _signed_in(client, sso_login)
    assert (await client.post(f"/v1/account/{uid}/deletion", json={"confirmEmail": EMAIL})).status_code == 202
    async with session_factory() as s:
        row = (await s.execute(select(AccountDeletionTable).where(AccountDeletionTable.user_id == uid))).scalar_one()
        row.started_at = _now()
        await s.commit()
    await _signed_in(client, sso_login)

    resp = await client.delete(f"/v1/account/{uid}/deletion")

    assert resp.status_code == 409


# -- re-authentication -----------------------------------------------------------


@pytest.mark.asyncio
async def test_reauth_as_the_same_account_returns_to_the_app(client, sso_login):
    uid = await _signed_in(client, sso_login)
    resp = await sso_login("alice", email=EMAIL, reauth_for=uid)
    assert resp.status_code == 302 and resp.headers["location"].endswith("?reauth=done")


@pytest.mark.asyncio
async def test_reauth_as_another_account_is_refused_and_creates_nothing(client, sso_login, session_factory):
    uid = await _signed_in(client, sso_login)
    resp = await sso_login("mallory", email="mallory@example.com", reauth_for=uid)

    assert resp.status_code == 302 and "reauth=failed" in resp.headers["location"]
    async with session_factory() as s:
        assert (await s.execute(select(UserTable).where(UserTable.username == "mallory"))).scalar_one_or_none() is None
    assert (await client.get("/v1/auth/session")).json()["user_id"] == uid           # still alice


@pytest.mark.asyncio
async def test_starting_a_reauth_needs_a_session_and_names_its_user(client, sso_login, monkeypatch):
    assert (await client.get("/v1/auth/oidc/login", params={"reauth": "true"})).status_code == 401

    uid = await _signed_in(client, sso_login)
    seen = {}

    async def begin_login(_redirect_uri, *, park=False, reauth_user_id=None):
        seen.update(park=park, reauth_user_id=reauth_user_id)
        return "https://login.example/authorize"

    monkeypatch.setattr(auth_router_module, "begin_login", begin_login)
    resp = await client.get("/v1/auth/oidc/login", params={"reauth": "true", "park": "true"})
    assert resp.status_code == 302 and seen == {"park": False, "reauth_user_id": uid}


# -- what a pending deletion freezes ---------------------------------------------


async def _pending(session_factory, user_id):
    async with session_factory() as s:
        s.add(AccountDeletionTable(user_id=user_id, user_ref=hash_identifier(user_id),
                                   requested_at=_now(), scheduled_for=_now() + timedelta(days=14)))
        await s.commit()


@pytest.mark.asyncio
async def test_the_scheduler_skips_tasks_of_a_pending_account(session_factory, seeded_user):
    async with session_factory() as s:
        other = UserTable(username="bob", oidc_subject="oid-bob", is_active=True)
        s.add(other)
        await s.flush()
        due = _now() - timedelta(minutes=1)
        mine = ScheduledTaskTable(user_id=seeded_user.id, prompt="p", schedule_kind="once", status="active", next_run_at=due)
        theirs = ScheduledTaskTable(user_id=other.id, prompt="p", schedule_kind="once", status="active", next_run_at=due)
        s.add_all([mine, theirs])
        await s.commit()
        mine_id, theirs_id = mine.id, theirs.id
    await _pending(session_factory, seeded_user.id)

    async with session_factory() as s:
        claimed = await claim_due_tasks(s, limit=10)

    assert theirs_id in claimed and mine_id not in claimed


@pytest.mark.asyncio
async def test_a_public_share_link_hides_while_its_owner_is_pending(session_factory, seeded_user, conversation_factory):
    conv = await conversation_factory(title="shared", messages=[{"sender": "user", "type": "text", "content": "hi"}])
    async with session_factory() as s:
        # is_active set explicitly: SQLite stores the "true" server default as text.
        share = ConversationShareTable(token="tok-pending", conversation_id=conv["conversation_id"],
                                       owner_user_id=seeded_user.id, snapshot_json={}, is_active=True)
        s.add(share)
        await s.commit()
    async with session_factory() as s:
        from_db = await load_active_share("tok-pending", s)
    assert from_db is not None

    await _pending(session_factory, seeded_user.id)
    async with session_factory() as s:
        with pytest.raises(HTTPException) as exc:
            await load_active_share("tok-pending", s)
    assert exc.value.status_code == 404


# -- the authorization fix found while building plan 32 ----------------------------


async def _someone_elses_agent(session_factory):
    async with session_factory() as s:
        owner = UserTable(username="carol", oidc_subject="oid-carol", is_active=True)
        s.add(owner)
        await s.flush()
        agent = AgentTable(slug="secret-bot", name="Secret Bot", description="d", icon="i",
                           owner_user_id=owner.id, is_active=True)
        s.add(agent)
        await s.commit()
        return agent


@pytest.mark.asyncio
async def test_a_share_cannot_be_continued_on_someone_elses_private_agent(session_factory, seeded_user):
    agent = await _someone_elses_agent(session_factory)
    share = SimpleNamespace(
        snapshot_json={"shareMode": "full", "messages": [{"id": "1", "sender": "user", "content": "hi"}],
                       "agent": {"id": agent.id}},
        title="t",
    )
    async with session_factory() as s:
        with pytest.raises(HTTPException) as exc:
            await create_conversation_from_share_record(
                db=s, share=share, current_user=seeded_user,
                first_message=MessageIn(sender="user", type="text", content="go on"),
            )
    assert exc.value.status_code == 400 and "private agent" in exc.value.detail


@pytest.mark.asyncio
async def test_a_run_on_someone_elses_private_agent_is_refused(session_factory, seeded_user, seeded_agent):
    agent = await _someone_elses_agent(session_factory)
    async with session_factory() as s:
        conv = ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id, title="mine")
        s.add(conv)
        await s.flush()
        with pytest.raises(HTTPException) as exc:
            await create_inference_run_record(
                db=s, user_id=seeded_user.id, conversation=conv, parent_message_id="m1",
                message_path=None, agent=agent, mode="send",
            )
    assert exc.value.status_code == 403
