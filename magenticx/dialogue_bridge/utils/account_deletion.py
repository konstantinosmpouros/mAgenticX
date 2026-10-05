"""Account deletion (plan 32): the request, the grace period, and the purge.

The purge is the part that must be right under failure. It removes everything
one user holds — up to tens of GB — across chat_db, the agents service's
``agent_runtime`` database, its checkpoints and its volume, on a box every other
stack shares. So it is built like the data export (plan 27): never one big
operation, always small committed batches.

* **Resumable.** ``account_deletions.step`` is the last step that finished. A
  crash, a redeploy or a failed call resumes after it; nothing starts over.
* **Idempotent.** Every step deletes "whatever is still there", so a retried
  step after a partial success finds less, never an error.
* **Bounded.** Conversations, messages and blobs go in batches of
  ``ACCOUNT_PURGE_*_BATCH``, each its own short transaction: no long locks, no
  WAL spike, no unbounded memory — a 50 GB account is many small deletes.
* **Explicit.** Child rows are deleted before their parents rather than left to
  ``ON DELETE CASCADE``: that is what keeps each transaction small, and it makes
  the purge independent of the database enforcing foreign keys at all.
* **Never someone else's data.** If another user's conversation still points at
  one of this user's custom agents, deleting the agent would cascade into it —
  so the purge stops there and says so, rather than destroy it.
* **One worker at a time per deletion.** A claim is a lease (``next_attempt_at``
  pushed forward and renewed after every batch), taken under ``FOR UPDATE SKIP
  LOCKED`` on Postgres.
"""
from __future__ import annotations

import asyncio
import hmac
import time
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Awaitable, Callable, Optional
from urllib.parse import quote

import httpx
from fastapi import HTTPException, status
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

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
    ScheduledTaskTable,
    SessionLocal,
    UserAgentToolPrefTable,
    UserPreferencesTable,
    UserTable,
)
from core.logging import get_logger, hash_identifier
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from utils.account_status import open_deletion
from utils.auth import revoke_all_sessions

logger = get_logger(__name__)

_AGENTS_BASE_URL = settings.upstream.agents_service_url.rstrip("/")

#: How long a claim holds a deletion before another worker may take it over.
#: Renewed after every batch, so only a worker that has stopped loses it.
_LEASE = timedelta(minutes=15)

STEP_SESSIONS = "sessions"
STEP_AGENT_THREADS = "agent_threads"
STEP_AGENT_RUNTIME = "agent_runtime"
STEP_CONVERSATIONS = "conversations"
STEP_USER = "user"
#: The purge order. Threads need the messages (they name the threads), so they
#: go before the conversations; the agents service's data goes before chat_db's
#: so a failure there never leaves chat_db already emptied; the user row goes
#: last — until then the user still exists for every retry.
STEPS = (STEP_SESSIONS, STEP_AGENT_THREADS, STEP_AGENT_RUNTIME, STEP_CONVERSATIONS, STEP_USER)

_AGENT_COUNT_KEYS = (
    "agent_memories", "skill_pool", "skill_files", "agent_skills",
    "agent_definitions", "agent_definition_files",
)


class CrossUserReferenceError(Exception):
    """Another user's conversation uses one of this user's custom agents.

    Deleting the agent would cascade into that conversation — someone else's
    data — so the purge stops and an operator decides.
    """


def _utcnow() -> datetime:
    """Naive UTC, matching the ``timestamp without time zone`` columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# Requesting, cancelling, status
# ---------------------------------------------------------------------------
REAUTH_REQUIRED_DETAIL = "Please sign in again to confirm it's you."


def _confirm_target(user: UserTable) -> str:
    """What the user types to confirm: their email, or the username without one."""
    return (user.email or user.username or "").strip()


def reauth_required(login_at: Optional[int]) -> bool:
    """Whether the session's sign-in is too old to request a deletion.

    ``login_at`` is the token's ``lat``. A token minted before ``lat`` was added
    to access tokens has none, and counts as too old — fail closed.
    """
    if login_at is None:
        return True
    return time.time() - int(login_at) > settings.account_deletion.reauth_max_age_seconds


async def deletion_status(db: AsyncSession, user_id: str, login_at: Optional[int]) -> dict[str, Any]:
    """Everything the Delete account card and the pending-deletion screen show."""
    user = await db.get(UserTable, user_id)
    row = await open_deletion(db, user_id)
    return {
        "enabled": settings.account_deletion.enabled,
        "pending": row is not None,
        "requestedAt": row.requested_at if row else None,
        "scheduledFor": row.scheduled_for if row else None,
        "inProgress": bool(row and row.started_at),
        "graceDays": settings.account_deletion.grace_days,
        "reauthRequired": reauth_required(login_at),
        "confirmWith": _confirm_target(user) if user else "",
    }


async def request_deletion(db: AsyncSession, user_id: str, confirm: str, login_at: Optional[int]) -> dict[str, Any]:
    """Schedule the account for deletion and end every session it has.

    Refused unless the session signed in recently and the typed confirmation
    matches the account — both checked here, whatever the UI did. The request
    row and the sessions watermark commit in one transaction, so there is never
    a scheduled deletion whose sessions still work.
    """
    cfg = settings.account_deletion
    if not cfg.enabled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Account deletion is turned off right now.")
    if reauth_required(login_at):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=REAUTH_REQUIRED_DETAIL)
    user = await db.get(UserTable, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    expected = _confirm_target(user)
    # Constant-time, so the comparison does not leak how much of it matched.
    if not expected or not hmac.compare_digest(confirm.strip().casefold().encode(), expected.casefold().encode()):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That does not match your account.")
    if await open_deletion(db, user_id) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Your account is already scheduled for deletion.")

    now = _utcnow()
    db.add(AccountDeletionTable(
        user_id=user_id,
        user_ref=hash_identifier(user_id),
        requested_at=now,
        scheduled_for=now + timedelta(days=cfg.grace_days),
    ))
    try:
        # Commits the request together with the watermark, then updates the cache.
        await revoke_all_sessions(db, user_id)
    except IntegrityError as exc:
        # The partial unique index: a concurrent request won the race.
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Your account is already scheduled for deletion.") from exc
    logger.info("account_deletion_requested", "Account deletion requested", user_ref=hash_identifier(user_id),
                grace_days=cfg.grace_days)
    return await deletion_status(db, user_id, login_at)


async def cancel_deletion(db: AsyncSession, user_id: str, login_at: Optional[int]) -> dict[str, Any]:
    """Cancel a pending deletion — possible until the purge has started.

    One conditional ``UPDATE``: it only matches a request the purger has not
    claimed (``started_at IS NULL``), and the purger claims under a row lock, so
    a cancel and a purge can never both win. The session's pending-deletion
    marker drops at the next refresh, which re-reads this row.
    """
    result = await db.execute(
        update(AccountDeletionTable)
        .where(
            AccountDeletionTable.user_id == user_id,
            AccountDeletionTable.cancelled_at.is_(None),
            AccountDeletionTable.completed_at.is_(None),
            AccountDeletionTable.started_at.is_(None),
        )
        .values(cancelled_at=_utcnow())
    )
    await db.commit()
    if not result.rowcount:
        if await open_deletion(db, user_id) is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                detail="Your account is already being deleted; it can no longer be cancelled.")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="There is no deletion to cancel.")
    logger.info("account_deletion_cancelled", "Account deletion cancelled", user_ref=hash_identifier(user_id))
    return await deletion_status(db, user_id, login_at)


# ---------------------------------------------------------------------------
# Claiming and recording
# ---------------------------------------------------------------------------
async def claim_due_deletion() -> Optional[str]:
    """Take one deletion whose grace period is over, or ``None``.

    The claim and the "not cancelled" check happen in one transaction under a
    row lock, so a cancel and a claim cannot both win. The lease
    (``next_attempt_at``) keeps every other worker off it while this one runs.
    """
    now = _utcnow()
    async with SessionLocal() as session:
        row = (
            await session.execute(
                select(AccountDeletionTable)
                .where(
                    AccountDeletionTable.cancelled_at.is_(None),
                    AccountDeletionTable.completed_at.is_(None),
                    AccountDeletionTable.scheduled_for <= now,
                    or_(
                        AccountDeletionTable.next_attempt_at.is_(None),
                        AccountDeletionTable.next_attempt_at <= now,
                    ),
                )
                .order_by(AccountDeletionTable.scheduled_for)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.started_at = row.started_at or now
        row.attempts = (row.attempts or 0) + 1
        row.next_attempt_at = now + _LEASE
        await session.commit()
        return row.id


async def _save_progress(deletion_id: str, counts: dict[str, Any], step: Optional[str] = None) -> None:
    """Renew the lease and persist running totals (and, at a step's end, the step)."""
    values: dict[str, Any] = {"next_attempt_at": _utcnow() + _LEASE, "counts": dict(counts)}
    if step is not None:
        values["step"] = step
    async with SessionLocal() as session:
        await session.execute(
            update(AccountDeletionTable).where(AccountDeletionTable.id == deletion_id).values(**values)
        )
        await session.commit()


async def _record_failure(deletion_id: str, exc: BaseException) -> None:
    """Back off and remember what failed — the exception's class, never its text."""
    async with SessionLocal() as session:
        row = await session.get(AccountDeletionTable, deletion_id)
        if row is None:
            return
        backoff = min(60 * 2 ** max((row.attempts or 1) - 1, 0), settings.account_deletion.retry_max_seconds)
        row.next_attempt_at = _utcnow() + timedelta(seconds=backoff)
        row.last_error_type = type(exc).__name__
        await session.commit()
        attempts, user_ref, step = row.attempts, row.user_ref, row.step
    log = logger.error if isinstance(exc, CrossUserReferenceError) else logger.warning
    log(
        "account_purge_step_failed",
        "An account purge step failed; it will be retried",
        user_ref=user_ref,
        last_step=step,
        attempts=attempts,
        retry_in_seconds=backoff,
        error_type=type(exc).__name__,
    )


# ---------------------------------------------------------------------------
# The steps
# ---------------------------------------------------------------------------
def _agents_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    )


def _agents_user_url(user_id: str, suffix: str = "") -> str:
    return f"{_AGENTS_BASE_URL}/users/{quote(user_id, safe='')}{suffix}"


async def _conversation_id_pages(user_id: str) -> AsyncIterator[list[str]]:
    """The user's conversation ids, a page at a time, by keyset (reads only)."""
    after: Optional[str] = None
    size = settings.account_deletion.conversation_batch
    while True:
        query = select(ConversationTable.id).where(ConversationTable.user_id == user_id)
        if after is not None:
            query = query.where(ConversationTable.id > after)
        async with SessionLocal() as session:
            ids = list((await session.execute(query.order_by(ConversationTable.id).limit(size))).scalars())
        if ids:
            yield ids
        if len(ids) < size:
            return
        after = ids[-1]


async def _step_sessions(user_id: str, deletion_id: str, counts: dict[str, Any]) -> None:
    """End every session again: the request did, but a purge must not depend on it."""
    async with SessionLocal() as session:
        if await session.get(UserTable, user_id) is not None:
            await revoke_all_sessions(session, user_id)


async def _step_agent_threads(user_id: str, deletion_id: str, counts: dict[str, Any]) -> None:
    """Send the user's checkpoint thread ids to the agents service, in batches.

    Collected per page of conversations (an indexed read of a few hundred
    messages), never as one DISTINCT over every message the user ever sent.
    """
    batch = settings.account_deletion.thread_batch
    pending: list[str] = []
    headers = internal_service_headers(None)

    async with _agents_client() as client:
        async def flush() -> None:
            if not pending:
                return
            resp = await client.post(
                _agents_user_url(user_id, "/purge/threads"), json={"thread_ids": list(pending)}, headers=headers
            )
            resp.raise_for_status()
            counts["checkpoint_threads"] = counts.get("checkpoint_threads", 0) + len(pending)
            pending.clear()
            await _save_progress(deletion_id, counts)

        async for conversation_ids in _conversation_id_pages(user_id):
            # Read, then close the session before any HTTP call: a connection
            # must never be held while waiting on another service.
            async with SessionLocal() as session:
                thread_ids = list(
                    (
                        await session.execute(
                            select(MessageTable.checkpoint_thread_id)
                            .where(
                                MessageTable.conversation_id.in_(conversation_ids),
                                MessageTable.checkpoint_thread_id.is_not(None),
                            )
                            .distinct()
                        )
                    ).scalars()
                )
            for thread_id in thread_ids:
                pending.append(thread_id)
                if len(pending) >= batch:
                    await flush()
        await flush()


async def _step_agent_runtime(user_id: str, deletion_id: str, counts: dict[str, Any]) -> None:
    """Have the agents service delete its rows and the user's workspace folder."""
    async with _agents_client() as client:
        resp = await client.delete(_agents_user_url(user_id), headers=internal_service_headers(None))
        resp.raise_for_status()
        body = resp.json()
    if not isinstance(body, dict):
        raise ValueError("unexpected purge response from the agents service")
    for key in _AGENT_COUNT_KEYS:
        counts[key] = counts.get(key, 0) + int(body.get(key, 0))
    counts["workspace_removed"] = bool(body.get("workspace_removed")) or bool(counts.get("workspace_removed"))


def within_byte_budget(rows: list, budget: int) -> tuple[list[str], int]:
    """The leading blobs of ``rows`` (``(blob_id, length)``) that fit ``budget`` —
    always at least one, so a single blob larger than the budget still goes."""
    chosen: list[str] = []
    total = 0
    for blob_id, length in rows:
        size = int(length or 0)
        if chosen and total + size > budget:
            break
        chosen.append(blob_id)
        total += size
    return chosen, total


async def pace_bytes(batch_bytes: int, started: float) -> None:
    """Hold the purge to ``ACCOUNT_PURGE_MAX_BYTES_PER_SECOND``.

    A batch that finished faster than its share of the budget waits out the
    rest, so the deletion — and the WAL it writes — never bursts above the cap
    on a disk the other stacks share. A batch that was already slower (the disk
    is the bottleneck) does not wait at all.
    """
    owed = batch_bytes / settings.account_deletion.max_bytes_per_second - (time.monotonic() - started)
    if owed > 0:
        await asyncio.sleep(owed)


async def _delete_conversation_batch(conversation_ids: list[str], deletion_id: str, counts: dict[str, Any]) -> None:
    """Empty a batch of conversations, then delete them — each part its own transaction."""
    cfg = settings.account_deletion
    message_ids_of_batch = select(MessageTable.id).where(MessageTable.conversation_id.in_(conversation_ids))

    # 1. Attachment bytes: the bulk. Batched by size, then paced (see below).
    while True:
        started = time.monotonic()
        async with SessionLocal() as session:
            rows = (
                await session.execute(
                    select(AttachmentTable.blob_id, func.length(BlobTable.data))
                    .join(BlobTable, BlobTable.id == AttachmentTable.blob_id)
                    .where(AttachmentTable.message_id.in_(message_ids_of_batch))
                    .limit(cfg.blob_batch)
                )
            ).all()
            if not rows:
                break
            blob_ids, batch_bytes = within_byte_budget(rows, cfg.blob_batch_bytes)
            removed = await session.execute(delete(AttachmentTable).where(AttachmentTable.blob_id.in_(blob_ids)))
            await session.execute(delete(BlobTable).where(BlobTable.id.in_(blob_ids)))
            await session.commit()
        counts["blobs"] = counts.get("blobs", 0) + len(blob_ids)
        counts["blob_bytes"] = counts.get("blob_bytes", 0) + batch_bytes
        counts["attachments"] = counts.get("attachments", 0) + (removed.rowcount or 0)
        await _save_progress(deletion_id, counts)
        await pace_bytes(batch_bytes, started)

    # 2. Attachments without bytes, then messages (with their embeddings).
    async with SessionLocal() as session:
        removed = await session.execute(delete(AttachmentTable).where(AttachmentTable.message_id.in_(message_ids_of_batch)))
        await session.commit()
    counts["attachments"] = counts.get("attachments", 0) + (removed.rowcount or 0)
    while True:
        async with SessionLocal() as session:
            ids = list((await session.execute(message_ids_of_batch.limit(cfg.message_batch))).scalars())
            if not ids:
                break
            embeddings = await session.execute(delete(MessageEmbeddingTable).where(MessageEmbeddingTable.message_id.in_(ids)))
            await session.execute(delete(MessageTable).where(MessageTable.id.in_(ids)))
            await session.commit()
        counts["messages"] = counts.get("messages", 0) + len(ids)
        counts["embeddings"] = counts.get("embeddings", 0) + (embeddings.rowcount or 0)
        await _save_progress(deletion_id, counts)

    # 3. What hangs off the conversation itself, then the conversations.
    async with SessionLocal() as session:
        await session.execute(delete(ConversationReportTable).where(ConversationReportTable.conversation_id.in_(conversation_ids)))
        await session.execute(delete(ConversationShareTable).where(ConversationShareTable.conversation_id.in_(conversation_ids)))
        removed = await session.execute(delete(ConversationTable).where(ConversationTable.id.in_(conversation_ids)))
        await session.commit()
    counts["conversations"] = counts.get("conversations", 0) + (removed.rowcount or 0)
    await _save_progress(deletion_id, counts)


async def _step_conversations(user_id: str, deletion_id: str, counts: dict[str, Any]) -> None:
    """Delete every conversation, a batch at a time, until none is left.

    Always "the first batch still there" rather than a keyset: deleted rows
    drop out, so a resumed purge simply continues with what remains.
    """
    size = settings.account_deletion.conversation_batch
    while True:
        async with SessionLocal() as session:
            ids = list(
                (
                    await session.execute(
                        select(ConversationTable.id)
                        .where(ConversationTable.user_id == user_id)
                        .order_by(ConversationTable.id)
                        .limit(size)
                    )
                ).scalars()
            )
        if not ids:
            return
        await _delete_conversation_batch(ids, deletion_id, counts)


async def _step_user(user_id: str, deletion_id: str, counts: dict[str, Any]) -> None:
    """Delete the user's remaining rows and the user, and close the step — atomically.

    Recording the step in the same transaction as the delete means there is no
    moment where the user is gone but the record says otherwise.
    """
    async with SessionLocal() as session:
        own_agents = select(AgentTable.id).where(AgentTable.owner_user_id == user_id)
        foreign = (
            await session.execute(
                select(func.count())
                .select_from(ConversationTable)
                .where(ConversationTable.agent_id.in_(own_agents), ConversationTable.user_id != user_id)
            )
        ).scalar_one()
        if foreign:
            raise CrossUserReferenceError(f"{foreign} conversation(s) of other users use this user's agents")
        for table, column in (
            (UserPreferencesTable, UserPreferencesTable.user_id),
            (UserAgentToolPrefTable, UserAgentToolPrefTable.user_id),
            (ScheduledTaskTable, ScheduledTaskTable.user_id),
            (ConversationReportTable, ConversationReportTable.user_id),
            (ConversationShareTable, ConversationShareTable.owner_user_id),
            (AgentTable, AgentTable.owner_user_id),
        ):
            await session.execute(delete(table).where(column == user_id))
        removed = await session.execute(delete(UserTable).where(UserTable.id == user_id))
        await session.execute(
            update(AccountDeletionTable)
            .where(AccountDeletionTable.id == deletion_id)
            .values(user_id=None, step=STEP_USER, counts={**counts, "user": removed.rowcount or 0})
        )
        await session.commit()
    counts["user"] = removed.rowcount or 0


_STEP_FUNCS: dict[str, Callable[[str, str, dict[str, Any]], Awaitable[None]]] = {
    STEP_SESSIONS: _step_sessions,
    STEP_AGENT_THREADS: _step_agent_threads,
    STEP_AGENT_RUNTIME: _step_agent_runtime,
    STEP_CONVERSATIONS: _step_conversations,
    STEP_USER: _step_user,
}


# ---------------------------------------------------------------------------
# Running a purge
# ---------------------------------------------------------------------------
async def run_purge(deletion_id: str) -> None:
    """Run the remaining steps of one claimed deletion, then close it.

    Raises the step's exception on failure (the caller records it); every
    step that finished is already saved, so the next attempt resumes after it.
    """
    async with SessionLocal() as session:
        row = await session.get(AccountDeletionTable, deletion_id)
        if row is None:
            return
        user_id, done, user_ref = row.user_id, row.step, row.user_ref
        counts: dict[str, Any] = dict(row.counts or {})

    remaining = STEPS[STEPS.index(done) + 1:] if done in STEPS else STEPS
    if user_id is not None:
        for name in remaining:
            await _STEP_FUNCS[name](user_id, deletion_id, counts)
            if name != STEP_USER:  # the user step records itself, atomically
                await _save_progress(deletion_id, counts, step=name)

    async with SessionLocal() as session:
        await session.execute(
            update(AccountDeletionTable)
            .where(AccountDeletionTable.id == deletion_id)
            .values(completed_at=_utcnow(), next_attempt_at=None, last_error_type=None, counts=counts)
        )
        await session.commit()
    logger.info("account_purged", "Account deletion completed", user_ref=user_ref, **counts)


async def purge_due_once() -> bool:
    """Claim and run one due deletion. Returns whether there was one."""
    deletion_id = await claim_due_deletion()
    if deletion_id is None:
        return False
    try:
        await run_purge(deletion_id)
    except (httpx.HTTPError, SQLAlchemyError, ValueError, CrossUserReferenceError) as exc:
        await _record_failure(deletion_id, exc)
    return True


async def run_account_purger(stop_event: asyncio.Event) -> None:
    """Background loop: purge accounts whose grace period is over.

    Runs one deletion at a time — the purge is I/O-heavy and the box is shared.
    After a productive pass it looks again at once; when idle it sleeps
    ``ACCOUNT_PURGE_INTERVAL_SECONDS``. Exits promptly when ``stop_event`` is set.
    """
    if not settings.account_deletion.enabled:
        logger.info("account_purger_disabled", "Account purger disabled via settings")
        return
    logger.info("account_purger_started", "Account purger started")
    while not stop_event.is_set():
        worked = False
        try:
            worked = await purge_due_once()
        except SQLAlchemyError as exc:
            # The claim itself failed (database unreachable): wait and retry.
            logger.warning("account_purger_claim_failed", "Could not claim a due deletion", error_type=type(exc).__name__)
        except Exception:
            # A background loop that dies stops every deletion silently — far
            # worse than one logged failure. Log loudly and keep the loop alive,
            # as the embedding sweeper does.
            logger.error("account_purger_unexpected_error", "Unexpected error in the account purger", exc_info=True)
        if worked:
            continue
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=settings.account_deletion.purge_interval_seconds)
        except asyncio.TimeoutError:
            pass
