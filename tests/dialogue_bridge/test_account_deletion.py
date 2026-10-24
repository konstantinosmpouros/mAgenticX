"""Account deletion (plan 32) — the purge engine.

Run against the real schema on SQLite, with the agents service played by an
``httpx.MockTransport``. What is pinned:

* a purge removes **everything** of the user in every table — blobs included,
  which a plain user delete orphans — and **nothing** of anyone else;
* it asks the agents service to drop the user's checkpoint threads and data;
* a failed step backs off and the next attempt resumes **after** the last
  finished step, with running totals intact;
* another user's conversation that uses this user's agent stops the purge
  instead of being cascaded away;
* the claim is a lease, a cancelled or not-yet-due request is never purged, and
  the record keeps only a hashed id once the user is gone.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

import utils.account_deletion as account_deletion
from core.database import (
    AccountDeletionTable,
    AgentTable,
    AttachmentTable,
    BlobTable,
    ConversationReportTable,
    ConversationShareTable,
    ConversationTable,
    MessageEmbeddingTable,
    MessageTable,
    MessageUsageTable,
    ScheduledTaskTable,
    ToolUsageDailyTable,
    ToolUsageTable,
    UsageDailyGroupTable,
    UsageDailyTable,
    UserAgentToolPrefTable,
    UserPreferencesTable,
    UserTable,
)
from core.logging import hash_identifier
from core.settings import AccountDeletionSettings, settings

AGENT_COUNTS = {
    "agent_memories": 4, "skill_pool": 2, "skill_files": 3, "agent_skills": 1,
    "agent_definitions": 1, "agent_definition_files": 2,
    "conversation_files": 5, "conversation_file_blobs": 3, "workspace_removed": True,
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.fixture(autouse=True)
def _purge_env(monkeypatch, session_factory):
    """Point the module at the test database, with tiny batches so paging is real."""
    monkeypatch.setattr(account_deletion, "SessionLocal", session_factory)
    cfg = settings.account_deletion
    monkeypatch.setattr(cfg, "conversation_batch", 2)
    monkeypatch.setattr(cfg, "message_batch", 3)
    monkeypatch.setattr(cfg, "blob_batch", 1)
    monkeypatch.setattr(cfg, "thread_batch", 2)


class Upstream:
    """The agents service: records calls; can be told to fail the user delete."""

    def __init__(self):
        self.thread_batches: list[list[str]] = []
        self.user_deletes: list[str] = []
        self.fail_user_delete = False

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/purge/threads"):
            batch = list(httpx.Response(200, content=request.content).json()["thread_ids"])
            self.thread_batches.append(batch)
            return httpx.Response(200, json={"deleted": len(batch)})
        if request.method == "DELETE":
            self.user_deletes.append(request.url.path)
            if self.fail_user_delete:
                return httpx.Response(503, json={"detail": "retry"})
            return httpx.Response(200, json=AGENT_COUNTS)
        return httpx.Response(404)


@pytest.fixture()
def upstream(monkeypatch):
    real = httpx.AsyncClient
    up = Upstream()
    transport = httpx.MockTransport(up.handle)
    monkeypatch.setattr(account_deletion.httpx, "AsyncClient",
                        lambda *a, **k: real(transport=transport, timeout=k.get("timeout")))
    return up


async def _seed_user_data(session_factory, user, agent, *, conversations=3, messages=4):
    """A user with everything a user can hold. Returns the ids to check later."""
    ids = {"conversations": [], "messages": [], "blobs": [], "threads": set()}
    async with session_factory() as s:
        own_agent = AgentTable(slug="my-bot", name="My Bot", description="d", icon="i", owner_user_id=user.id)
        s.add(own_agent)
        s.add(UserPreferencesTable(user_id=user.id))
        s.add(UserAgentToolPrefTable(user_id=user.id, agent_slug="omni", tool_key="t", state="enabled"))
        s.add(ScheduledTaskTable(user_id=user.id, prompt="p", schedule_kind="once"))
        await s.flush()
        for c in range(conversations):
            conv = ConversationTable(user_id=user.id, agent_id=agent.id if c else own_agent.id, title=f"c{c}")
            s.add(conv)
            await s.flush()
            ids["conversations"].append(conv.id)
            for m in range(messages):
                thread = f"thread-{c}-{m % 2}"
                msg = MessageTable(conversation_id=conv.id, sender="user" if m % 2 == 0 else "ai",
                                   content=f"m{m}", checkpoint_thread_id=thread if m % 2 else None)
                s.add(msg)
                await s.flush()
                ids["messages"].append(msg.id)
                if m % 2:
                    ids["threads"].add(thread)
                    s.add(MessageEmbeddingTable(message_id=msg.id, embedding=[0.0] * 1536, model="m"))
                    s.add(MessageUsageTable(message_id=msg.id, conversation_id=conv.id, user_id=user.id,
                                            agent_id=agent.id, scope="main", agent_name="A",
                                            created_at=datetime(2026, 10, 8)))
                    s.add(ToolUsageTable(message_id=msg.id, conversation_id=conv.id, user_id=user.id,
                                         agent_id=agent.id, scope="main", agent_name="A", tool_name="read_file",
                                         calls=1, created_at=datetime(2026, 10, 8)))
                if m == 0:
                    blob = BlobTable(data=b"x" * 1000)
                    s.add(blob)
                    await s.flush()
                    ids["blobs"].append(blob.id)
                    s.add(AttachmentTable(message_id=msg.id, file_name="f.pdf", mime_type="application/pdf",
                                          size_bytes=1000, blob_id=blob.id))
            s.add(ConversationShareTable(token=f"tok-{c}", conversation_id=conv.id, owner_user_id=user.id,
                                         snapshot_json={}))
            s.add(ConversationReportTable(conversation_id=conv.id, user_id=user.id, reason="spam"))
        # Usage rollups (plan 33) outlive conversations, so only the user step removes them.
        s.add(UsageDailyTable(user_id=user.id, day=date(2026, 10, 8), agent_key=agent.id, agent_id=agent.id, answers=2))
        s.add(UsageDailyGroupTable(user_id=user.id, day=date(2026, 10, 8), agent_key=agent.id, scope="main",
                                   group_name="A", model_name="gpt-5", calls=2))
        # The tool rollup (plan 41) likewise.
        s.add(ToolUsageDailyTable(user_id=user.id, day=date(2026, 10, 8), agent_key=agent.id, agent_id=agent.id,
                                  tool_name="read_file", calls=2))
        await s.commit()
    return ids


async def _other_user(session_factory, agent):
    """Someone else, with a conversation, a message and an attachment of their own."""
    async with session_factory() as s:
        other = UserTable(username="someone-else", oidc_subject="oid-else", is_active=True)
        s.add(other)
        await s.flush()
        conv = ConversationTable(user_id=other.id, agent_id=agent.id, title="theirs")
        s.add(conv)
        await s.flush()
        msg = MessageTable(conversation_id=conv.id, sender="user", content="mine")
        s.add(msg)
        await s.flush()
        blob = BlobTable(data=b"theirs")
        s.add(blob)
        await s.flush()
        s.add(AttachmentTable(message_id=msg.id, file_name="t.txt", mime_type="text/plain", blob_id=blob.id))
        s.add(UserPreferencesTable(user_id=other.id))
        await s.commit()
        return other.id, conv.id, blob.id


async def _request(session_factory, user_id, *, due=True, cancelled=False) -> str:
    async with session_factory() as s:
        row = AccountDeletionTable(
            user_id=user_id, user_ref=hash_identifier(user_id), requested_at=_now() - timedelta(days=15),
            scheduled_for=_now() + (timedelta(seconds=-1) if due else timedelta(days=1)),
            cancelled_at=_now() if cancelled else None,
        )
        s.add(row)
        await s.commit()
        return row.id


async def _count(session_factory, model, *where) -> int:
    async with session_factory() as s:
        return (await s.execute(select(func.count()).select_from(model).where(*where))).scalar_one()


# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_purge_removes_everything_of_the_user_and_nothing_else(session_factory, seeded_user, seeded_agent, upstream):
    ids = await _seed_user_data(session_factory, seeded_user, seeded_agent)
    other_id, other_conv, other_blob = await _other_user(session_factory, seeded_agent)
    deletion_id = await _request(session_factory, seeded_user.id)

    assert await account_deletion.purge_due_once() is True

    uid = seeded_user.id
    assert await _count(session_factory, UserTable, UserTable.id == uid) == 0
    assert await _count(session_factory, ConversationTable, ConversationTable.user_id == uid) == 0
    assert await _count(session_factory, MessageTable, MessageTable.id.in_(ids["messages"])) == 0
    assert await _count(session_factory, MessageEmbeddingTable, MessageEmbeddingTable.message_id.in_(ids["messages"])) == 0
    assert await _count(session_factory, BlobTable, BlobTable.id.in_(ids["blobs"])) == 0       # not orphaned
    assert await _count(session_factory, AttachmentTable, AttachmentTable.blob_id.in_(ids["blobs"])) == 0
    for model, column in ((UserPreferencesTable, UserPreferencesTable.user_id),
                          (UserAgentToolPrefTable, UserAgentToolPrefTable.user_id),
                          (ScheduledTaskTable, ScheduledTaskTable.user_id),
                          (ConversationReportTable, ConversationReportTable.user_id),
                          (ConversationShareTable, ConversationShareTable.owner_user_id),
                          (MessageUsageTable, MessageUsageTable.user_id),
                          (UsageDailyTable, UsageDailyTable.user_id),
                          (UsageDailyGroupTable, UsageDailyGroupTable.user_id),
                          (ToolUsageTable, ToolUsageTable.user_id),
                          (ToolUsageDailyTable, ToolUsageDailyTable.user_id),
                          (AgentTable, AgentTable.owner_user_id)):
        assert await _count(session_factory, model, column == uid) == 0, model.__tablename__

    # Someone else's data is untouched.
    assert await _count(session_factory, UserTable, UserTable.id == other_id) == 1
    assert await _count(session_factory, ConversationTable, ConversationTable.id == other_conv) == 1
    assert await _count(session_factory, BlobTable, BlobTable.id == other_blob) == 1
    assert await _count(session_factory, UserPreferencesTable, UserPreferencesTable.user_id == other_id) == 1

    # The agents service was asked for every thread (in batches) and the user's data.
    sent = [t for batch in upstream.thread_batches for t in batch]
    assert sorted(sent) == sorted(ids["threads"]) and all(len(b) <= 2 for b in upstream.thread_batches)
    assert upstream.user_deletes == [f"/users/{uid}"]

    # The record survives, closed, without the raw id.
    async with session_factory() as s:
        row = await s.get(AccountDeletionTable, deletion_id)
    assert row.completed_at is not None and row.user_id is None
    assert row.user_ref == hash_identifier(uid) and uid not in str(row.counts)
    assert row.counts["conversations"] == 3 and row.counts["messages"] == 12
    assert row.counts["blobs"] == 3 and row.counts["blob_bytes"] == 3000
    assert row.counts["checkpoint_threads"] == len(ids["threads"])
    assert row.counts["agent_memories"] == 4 and row.counts["user"] == 1
    # Every conversation file the agents service held, deleted by user id (plan 43).
    assert row.counts["conversation_files"] == 5 and row.counts["conversation_file_blobs"] == 3


@pytest.mark.asyncio
async def test_a_request_not_yet_due_or_cancelled_is_never_purged(session_factory, seeded_user, seeded_agent, upstream):
    await _seed_user_data(session_factory, seeded_user, seeded_agent, conversations=1)
    await _request(session_factory, seeded_user.id, due=False)
    assert await account_deletion.purge_due_once() is False

    async with session_factory() as s:
        other = UserTable(username="u2", oidc_subject="oid-u2", is_active=True)
        s.add(other)
        await s.commit()
        other_id = other.id
    await _request(session_factory, other_id, cancelled=True)
    assert await account_deletion.purge_due_once() is False
    assert await _count(session_factory, UserTable, UserTable.id.in_([seeded_user.id, other_id])) == 2
    assert upstream.user_deletes == []


@pytest.mark.asyncio
async def test_a_failed_step_backs_off_and_the_retry_resumes_after_it(session_factory, seeded_user, seeded_agent, upstream):
    await _seed_user_data(session_factory, seeded_user, seeded_agent)
    deletion_id = await _request(session_factory, seeded_user.id)
    upstream.fail_user_delete = True

    assert await account_deletion.purge_due_once() is True
    async with session_factory() as s:
        row = await s.get(AccountDeletionTable, deletion_id)
    assert row.completed_at is None and row.step == account_deletion.STEP_AGENT_THREADS
    assert row.last_error_type == "HTTPStatusError" and row.next_attempt_at > _now()
    # The agents service's part comes before chat_db's: nothing was deleted here yet.
    assert await _count(session_factory, ConversationTable, ConversationTable.user_id == seeded_user.id) == 3
    # Backing off: not claimable again yet.
    assert await account_deletion.purge_due_once() is False

    threads_sent = len(upstream.thread_batches)
    upstream.fail_user_delete = False
    async with session_factory() as s:
        (await s.get(AccountDeletionTable, deletion_id)).next_attempt_at = _now() - timedelta(seconds=1)
        await s.commit()
    assert await account_deletion.purge_due_once() is True

    async with session_factory() as s:
        row = await s.get(AccountDeletionTable, deletion_id)
    assert row.completed_at is not None and row.attempts == 2
    assert len(upstream.thread_batches) == threads_sent          # resumed after the threads step
    assert await _count(session_factory, UserTable, UserTable.id == seeded_user.id) == 0


@pytest.mark.asyncio
async def test_a_purge_cut_off_mid_conversations_resumes_with_accurate_totals(
    session_factory, seeded_user, seeded_agent, upstream, monkeypatch
):
    await _seed_user_data(session_factory, seeded_user, seeded_agent, conversations=5)
    deletion_id = await _request(session_factory, seeded_user.id)
    real = account_deletion._delete_conversation_batch
    calls = {"n": 0}

    async def flaky(conversation_ids, did, counts):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OperationalError("DELETE", {}, Exception("connection reset"))
        await real(conversation_ids, did, counts)

    monkeypatch.setattr(account_deletion, "_delete_conversation_batch", flaky)
    assert await account_deletion.purge_due_once() is True
    async with session_factory() as s:
        row = await s.get(AccountDeletionTable, deletion_id)
    assert row.step == account_deletion.STEP_AGENT_RUNTIME and row.last_error_type == "OperationalError"
    assert row.counts["conversations"] == 2                       # the first batch is recorded
    assert await _count(session_factory, ConversationTable, ConversationTable.user_id == seeded_user.id) == 3

    monkeypatch.setattr(account_deletion, "_delete_conversation_batch", real)
    async with session_factory() as s:
        (await s.get(AccountDeletionTable, deletion_id)).next_attempt_at = _now() - timedelta(seconds=1)
        await s.commit()
    assert await account_deletion.purge_due_once() is True
    async with session_factory() as s:
        row = await s.get(AccountDeletionTable, deletion_id)
    assert row.completed_at is not None
    assert row.counts["conversations"] == 5 and row.counts["messages"] == 20


@pytest.mark.asyncio
async def test_another_users_conversation_on_this_users_agent_stops_the_purge(
    session_factory, seeded_user, seeded_agent, upstream
):
    """A shared conversation imported by someone else can point at this user's
    custom agent; deleting the agent would cascade into their conversation."""
    await _seed_user_data(session_factory, seeded_user, seeded_agent, conversations=1)
    other_id, _, _ = await _other_user(session_factory, seeded_agent)
    async with session_factory() as s:
        own_agent = (await s.execute(select(AgentTable).where(AgentTable.owner_user_id == seeded_user.id))).scalar_one()
        theirs = ConversationTable(user_id=other_id, agent_id=own_agent.id, title="imported")
        s.add(theirs)
        await s.commit()
        theirs_id = theirs.id
    deletion_id = await _request(session_factory, seeded_user.id)

    assert await account_deletion.purge_due_once() is True

    async with session_factory() as s:
        row = await s.get(AccountDeletionTable, deletion_id)
    assert row.last_error_type == "CrossUserReferenceError" and row.completed_at is None
    assert row.step == account_deletion.STEP_CONVERSATIONS
    assert await _count(session_factory, ConversationTable, ConversationTable.id == theirs_id) == 1
    assert await _count(session_factory, UserTable, UserTable.id == seeded_user.id) == 1


@pytest.mark.asyncio
async def test_a_claim_is_a_lease_one_worker_per_deletion(session_factory, seeded_user):
    await _request(session_factory, seeded_user.id)
    first = await account_deletion.claim_due_deletion()
    assert first is not None
    assert await account_deletion.claim_due_deletion() is None


def test_deletion_settings_are_safe_by_default_and_bounded():
    fields = AccountDeletionSettings.model_fields
    assert fields["enabled"].default is True                      # a kill switch, on
    assert fields["grace_days"].default == 14
    for bad in ({"ACCOUNT_DELETION_GRACE_DAYS": 0}, {"ACCOUNT_DELETION_GRACE_DAYS": 31},
                {"ACCOUNT_PURGE_BLOB_BATCH": 0}, {"ACCOUNT_DELETION_REAUTH_MAX_AGE_SECONDS": 10}):
        with pytest.raises(ValidationError):
            AccountDeletionSettings.model_validate(bad)


# -- bounded I/O: bytes per transaction, bytes per second (from the 50 GB load test)


def test_a_blob_batch_is_bounded_by_bytes_but_always_takes_one():
    budget = account_deletion.within_byte_budget
    assert budget([("a", 30), ("b", 30), ("c", 30)], 64) == (["a", "b"], 60)
    assert budget([("big", 100), ("b", 1)], 64) == (["big"], 100)        # one oversized blob still goes
    assert budget([("a", None)], 64) == (["a"], 0)


@pytest.mark.asyncio
async def test_the_purge_waits_out_its_byte_rate_only_when_ahead(monkeypatch):
    slept: list[float] = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(account_deletion.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(settings.account_deletion, "max_bytes_per_second", 10 * 1024 * 1024)
    now = account_deletion.time.monotonic()

    await account_deletion.pace_bytes(10 * 1024 * 1024, now)          # finished instantly: owes ~1 s
    await account_deletion.pace_bytes(10 * 1024 * 1024, now - 5)      # the disk was the bottleneck: owes nothing

    assert len(slept) == 1 and 0.9 < slept[0] <= 1.0


def test_purge_byte_limits_are_bounded():
    for bad in ({"ACCOUNT_PURGE_BLOB_BATCH_BYTES": 0}, {"ACCOUNT_PURGE_MAX_BYTES_PER_SECOND": 2 * 1024 ** 3}):
        with pytest.raises(ValidationError):
            AccountDeletionSettings.model_validate(bad)
