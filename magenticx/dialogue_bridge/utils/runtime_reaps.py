"""Deleting a conversation deletes its agents-service state too — guaranteed.

The agents service holds a conversation's checkpoint threads and its files
(``agent_runtime``), in another database, so no foreign key can cascade there.
Instead the delete writes an outbox row (``pending_runtime_reaps``) in its own
transaction: the conversation cannot disappear without leaving the note that
its runtime must go. The row is sent right after the commit and removed once
the agents service confirms; a failure keeps it, and it is retried after the
next delete and when the bridge starts. No loop, no TTL — this is deletion,
not retention.

The reap first stops the conversation's background sub-agent tasks (plan 41,
``POST /tasks/cancel-scope``), and the threads it drops include theirs (a
task's thread id is its task id).

The reap is by conversation id alone. It used to go agent by agent, and an
agent that had been deactivated or deleted meant its threads and files were
silently left behind.
"""
from __future__ import annotations

import httpx
from sqlalchemy import delete, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ConversationTable, ConversationTaskTable, MessageTable, PendingRuntimeReapTable, SessionLocal
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from utils.agents import build_conversation_reap_url

logger = get_logger(__name__)

#: Stops every background task of a conversation (plan 41 §14.3).
_CANCEL_SCOPE_URL = f"{settings.upstream.agents_service_url.rstrip('/')}/tasks/cancel-scope"

#: Rows sent per drain, oldest first — a backlog is worked off over a few
#: deletes rather than holding one delete's response.
DRAIN_BATCH = 20


async def enqueue_runtime_reap(db: AsyncSession, user_id: str, conversation_id: str) -> None:
    """Note, in the caller's transaction, what the agents service must drop.

    Must run before the conversation's messages are deleted: they are where the
    bridge recorded the checkpoint threads.
    """
    thread_ids = set(await db.scalars(
        select(MessageTable.checkpoint_thread_id)
        .where(MessageTable.conversation_id == conversation_id, MessageTable.checkpoint_thread_id.is_not(None))
        .distinct()
    ))
    # A background task's checkpoint thread is its task id (plan 41).
    thread_ids.update(await db.scalars(
        select(ConversationTaskTable.task_id).where(ConversationTaskTable.conversation_id == conversation_id)
    ))
    await db.merge(PendingRuntimeReapTable(
        conversation_id=conversation_id, user_id=user_id, thread_ids=sorted(thread_ids), attempts=0,
    ))


async def delete_conversation(db: AsyncSession, user_id: str, conversation: ConversationTable) -> None:
    """Delete a conversation and, once committed, its agents-service runtime.

    The one conversation delete: the conversation route, a "Try it" Reset and
    the trial sweeper (plan 40) all come through here. The reap is noted in
    this transaction (it reads the thread ids off the messages, so before they
    are gone), then sent once committed; a failed send is retried later and
    never blocks the delete.
    """
    await enqueue_runtime_reap(db, user_id, conversation.id)
    await db.execute(delete(ConversationTaskTable).where(ConversationTaskTable.conversation_id == conversation.id))
    await db.delete(conversation)
    await db.commit()
    await drain_runtime_reaps()


async def _send(client: httpx.AsyncClient, row: PendingRuntimeReapTable) -> None:
    # Stop the conversation's background tasks first (plan 41), so none is
    # still writing to a thread about to be dropped. A 404 is an agents
    # service without the task API: nothing to stop.
    cancelled = await client.post(
        _CANCEL_SCOPE_URL,
        json={"user_id": row.user_id, "conversation_id": row.conversation_id},
        headers=internal_service_headers(get_context().get("request_id")),
    )
    if cancelled.status_code != 404:
        cancelled.raise_for_status()
    resp = await client.post(
        build_conversation_reap_url(row.user_id, row.conversation_id),
        json={"thread_ids": list(row.thread_ids or [])},
        headers=internal_service_headers(get_context().get("request_id")),
    )
    resp.raise_for_status()


async def drain_runtime_reaps() -> int:
    """Send the pending reaps; returns how many the agents service confirmed.

    Never raises: it runs after a delete has committed and at boot, and neither
    may fail over it. A row it could not handle stays for the next drain.
    """
    try:
        return await _drain()
    except SQLAlchemyError as exc:
        logger.warning("conversation_reap_outbox_failed", "Could not work through the reap outbox",
                       error_type=type(exc).__name__)
        return 0


async def _drain() -> int:
    """Stops at the first failure: the agents service is then most likely down,
    and the rest would only wait out the same timeout. No database connection
    is held while waiting on the agents service."""
    async with SessionLocal() as db:
        rows = list(await db.scalars(
            select(PendingRuntimeReapTable).order_by(PendingRuntimeReapTable.created_at).limit(DRAIN_BATCH)
        ))
    if not rows:
        return 0
    reaped: list[str] = []
    failed: tuple[PendingRuntimeReapTable, str] | None = None
    async with httpx.AsyncClient(
        timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    ) as client:
        for row in rows:
            try:
                await _send(client, row)
            except httpx.HTTPError as exc:
                failed = (row, type(exc).__name__)
                break
            reaped.append(row.conversation_id)
    async with SessionLocal() as db:
        if reaped:
            await db.execute(
                delete(PendingRuntimeReapTable).where(PendingRuntimeReapTable.conversation_id.in_(reaped))
            )
        if failed is not None:
            row, error = failed
            await db.execute(
                update(PendingRuntimeReapTable)
                .where(PendingRuntimeReapTable.conversation_id == row.conversation_id)
                .values(attempts=PendingRuntimeReapTable.attempts + 1, last_error=error)
            )
            logger.warning("conversation_reap_outbox_retry",
                           "A deleted conversation's runtime is still there; retried later",
                           conversation_id=row.conversation_id, attempts=row.attempts + 1, error_type=error)
        await db.commit()
    if reaped:
        logger.info("conversation_reap_outbox_drained", "Reaped deleted conversations' runtime", count=len(reaped))
    return len(reaped)
