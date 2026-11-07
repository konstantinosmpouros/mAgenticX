"""Waking the orchestrator when a background task's subtree settles (plan 41 §3.6).

Modelled on the scheduled-task fire (``utils/scheduled_tasks.py``
``fire_scheduled_task``): the wake-up is an ordinary run started through the
normal pipeline, so it streams, persists and checkpoints like any other.

1. Find the **leaf of the task's branch** — the newest answer on the task's
   ``branch_thread_id`` — even if the user has since switched to another
   branch: the result belongs to the conversation the task was started from.
2. Write the **notice row**: sender ``user`` (the orchestrator's input is a
   HumanMessage), ``kind = task_notification``, ``task_notice`` for the UI and
   the notification's ``additional_kwargs`` for the agents service, content =
   the notification's text. Then start a ``send`` run on it — a
   ``delta_resume`` on the same thread, so the orchestrator sees exactly the
   notification as its next input — launch it, and announce ``run_started``
   on the conversation channel.
3. **409** (the conversation is busy): nothing now. The active run's
   middleware pulls the result before its next model call; the run-end hook
   below re-checks once the slot is free.
4. **429** (the user's active-run cap): retried with exponential backoff, a
   bounded number of times; then the reconcile loop owns it.
5. **Interactive is inherited**: the wake-up run takes the root run's
   ``scheduled_task_id``, so a scheduled task's wake-ups stay headless
   (``run_is_interactive``) and count toward that task's run history.

The agents service is told the wake-up was handled (``POST /tasks/{id}/notified``)
only once the run exists, or once the wake-up was deliberately skipped (the
user stopped the task — plan 41 D8 —, the conversation is gone, a "Try it"
trial, the account is being deleted, no branch to continue). Never on 409 or
429: an unnotified row is what the safety nets look for.

**When a run ends** (``on_run_finished``, registered with the run manager):
the conversation's **queued message goes first** — the user asked for it, and
the run it starts pulls any settled task's result before its first model call
anyway. Only when nothing was queued (or it could not be sent) is a pending
wake-up started — at most one; the run it starts pulls the others.

The **reconcile loop** (``reconcile_once``, at startup and then every
``ASYNC_TASKS_RECONCILE_INTERVAL_SECONDS``) sends queued messages a restart
left behind, and works through ``GET /tasks/unnotified`` — Redis is only the
doorbell; the agents service's ``parent_notified_at`` is the durable outbox.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    TASK_SETTLED_STATUSES,
    ConversationTable,
    ConversationTaskTable,
    MessageTable,
    SessionLocal,
    UserTable,
)
from core.logging import get_logger
from core.settings import settings
from schema import InferenceRunOut, OutboxItem
from utils.account_status import open_deletion
from utils.agents import get_agent_by_id
from utils.async_tasks import (
    AgentsTaskError,
    agents_get_task,
    agents_list_unnotified,
    agents_mark_notified,
    upsert_task_mirror,
)
from utils.composer_queue import pending_queue_conversations, send_queued_message
from utils.conversation_channel import publish_run_started
from utils.inference_runs import inference_run_manager, register_run_finished_hook
from utils.inference_start import create_run_and_respond
from utils.validators import load_conversation_full

logger = get_logger(__name__)

SessionFactory = Callable[[], AsyncSession]


class WakeOutcome(str, Enum):
    """What one wake-up attempt did."""
    WOKEN = "woken"        # a wake-up run was started
    SKIPPED = "skipped"    # deliberately not woken; the settle is handled
    BUSY = "busy"          # 409: the active run pulls the result
    DEFERRED = "deferred"  # 429 or the agents service unreachable: try later


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def find_branch_leaf(messages: list[MessageTable], branch_thread_id: str) -> Optional[MessageTable]:
    """The newest answer on the branch thread ``branch_thread_id``, or None.

    Every run that continues a branch inherits its ``checkpoint_thread_id``
    (``send``), and an edit or retry mints a new one, so the newest AI message
    on the thread is the end of the branch the task was started from. A
    ``send`` on it resumes that thread (the run walks up to the nearest
    committed answer if this one failed before committing).
    """
    on_branch = [m for m in messages if m.sender == "ai" and m.checkpoint_thread_id == branch_thread_id]
    if not on_branch:
        return None
    return max(on_branch, key=lambda m: (m.created_at, m.id))


def _duration_ms(row: Optional[ConversationTaskTable], now: datetime) -> Optional[int]:
    """How long the task ran, for the notice row ("· 2m 14s").

    The outbox entry can be consumed before the ``tasks:status`` entry that
    writes ``settled_at`` into the mirror (two independent streams), so a
    missing ``settled_at`` falls back to the wake-up time, which is at most a
    moment after the real settle.
    """
    if row is None or row.started_at is None:
        return None
    settled = row.settled_at or now
    return max(0, int((settled - row.started_at).total_seconds() * 1000))


async def _wake_once(item: OutboxItem, session_factory: SessionFactory) -> tuple[WakeOutcome, Optional[InferenceRunOut]]:
    """One attempt at waking the orchestrator for ``item`` (see the module doc)."""
    if item.cancelled_by_user:
        # The user pressed Stop: they know already (D8).
        return WakeOutcome.SKIPPED, None
    async with session_factory() as db:
        conversation = (
            await db.execute(
                select(ConversationTable).where(
                    ConversationTable.id == item.conversation_id, ConversationTable.user_id == item.user_id
                )
            )
        ).scalar_one_or_none()
        if conversation is None or conversation.is_trial:
            # Gone — or a builder "Try it" chat, whose panel runs only the
            # turns the user sends; its next turn pulls the result.
            return WakeOutcome.SKIPPED, None
        user = await db.get(UserTable, item.user_id)
        if user is None or not user.is_active or await open_deletion(db, user.id) is not None:
            return WakeOutcome.SKIPPED, None

        mirror = await db.get(ConversationTaskTable, item.task_id)
        if mirror is not None and mirror.notified_at is not None:
            # Handled already; only the agents service's mark is missing.
            return WakeOutcome.SKIPPED, None
        if mirror is None:
            # The status stream has not delivered it yet: mirror it now, for
            # the notice's name and for the "handled" mark below.
            task = await agents_get_task(item.task_id, item.user_id)
            if task is not None:
                mirror = await upsert_task_mirror(db, task)

        full = await load_conversation_full(db, user.id, conversation.id, trial=False)
        leaf = find_branch_leaf(list(full.messages), item.branch_thread_id)
        if leaf is None:
            logger.warning("task_wake_no_branch", "No branch left to wake the orchestrator on",
                           task_id=item.task_id, conversation_id=conversation.id)
            return WakeOutcome.SKIPPED, None
        root = next((m for m in full.messages if m.id == item.root_run_id), None)
        scheduled_task_id = root.scheduled_task_id if root is not None else None
        if not item.interactive and scheduled_task_id is None:
            logger.warning("task_wake_interactive_unknown",
                           "A non-interactive task's root run has no scheduled task; waking interactively",
                           task_id=item.task_id)
        agent = await get_agent_by_id(leaf.agent_id or conversation.agent_id)
        if agent is None:
            logger.warning("task_wake_agent_gone", "The orchestrator's agent is no longer available",
                           task_id=item.task_id, conversation_id=conversation.id)
            return WakeOutcome.SKIPPED, None

        now = _now()
        notice = MessageTable(
            conversation_id=conversation.id,
            parent_message_id=leaf.id,
            sender="user",
            content=item.notification_text(),
            kind="task_notification",
            task_notice={
                "task_id": item.task_id,
                "name": mirror.name if mirror is not None else (item.agent_slug or "task"),
                "status": item.status,
                "duration_ms": _duration_ms(mirror, now),
                "agent_kwargs": dict(item.notification.additional_kwargs),
            },
            created_at=now,
        )
        db.add(notice)
        await db.flush()
        if mirror is not None:
            mirror.notified_at = now
        db.expire(full, ["messages"])
        full = await load_conversation_full(db, user.id, conversation.id, trial=False)
        try:
            response = await create_run_and_respond(
                db=db,
                user_id=user.id,
                conversation=full,
                parent_message_id=notice.id,
                message_path=None,
                agent=agent,
                mode="send",
                scheduled_task_id=scheduled_task_id,
            )
        except HTTPException as exc:
            await db.rollback()
            if exc.status_code == status.HTTP_409_CONFLICT:
                return WakeOutcome.BUSY, None
            if exc.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
                return WakeOutcome.DEFERRED, None
            logger.warning("task_wake_refused", "The wake-up run was refused", task_id=item.task_id,
                           status_code=exc.status_code)
            return WakeOutcome.SKIPPED, None
    inference_run_manager.launch(response.run.id)
    logger.info("task_wake_started", "Orchestrator woken for a settled task", task_id=item.task_id,
                conversation_id=item.conversation_id, run_id=response.run.id)
    await publish_run_started(response.run)
    return WakeOutcome.WOKEN, response.run


async def _mark_handled(item: OutboxItem, session_factory: SessionFactory) -> None:
    """Record the settle as handled: in the mirror, then in the agents service."""
    try:
        async with session_factory() as db:
            mirror = await db.get(ConversationTaskTable, item.task_id)
            if mirror is not None and mirror.user_id == item.user_id and mirror.notified_at is None:
                mirror.notified_at = _now()
                await db.commit()
    except SQLAlchemyError:
        logger.warning("task_notified_mirror_failed", "Could not mark the mirrored task handled",
                       task_id=item.task_id, exc_info=True)
    try:
        if not await agents_mark_notified(item.task_id, item.user_id):
            logger.warning("task_notified_refused", "The agents service did not record the notification",
                           task_id=item.task_id)
    except AgentsTaskError as exc:
        # The mirror's mark keeps it from waking twice; the reconcile loop
        # sends the mark again.
        logger.warning("task_notified_failed", "Could not tell the agents service the task was handled",
                       task_id=item.task_id, error_type=str(exc))


async def handle_outbox_item(item: OutboxItem, session_factory: Optional[SessionFactory] = None) -> WakeOutcome:
    """Wake the orchestrator for one settled depth-1 task (429s retried with backoff)."""
    session_factory = session_factory or SessionLocal
    attempts = settings.async_tasks.wake_retry_attempts
    outcome = WakeOutcome.DEFERRED
    for attempt in range(attempts + 1):
        try:
            outcome, _run = await _wake_once(item, session_factory)
        except (AgentsTaskError, SQLAlchemyError) as exc:
            logger.warning("task_wake_failed", "Wake-up deferred: a dependency failed", task_id=item.task_id,
                           error_type=type(exc).__name__)
            return WakeOutcome.DEFERRED
        if outcome is not WakeOutcome.DEFERRED or attempt == attempts:
            break
        await asyncio.sleep(settings.async_tasks.wake_retry_base_seconds * (2 ** attempt))
    if outcome in (WakeOutcome.WOKEN, WakeOutcome.SKIPPED):
        await _mark_handled(item, session_factory)
    elif outcome is WakeOutcome.DEFERRED:
        logger.info("task_wake_deferred", "Wake-up deferred to the reconcile loop", task_id=item.task_id)
    return outcome


async def wake_pending_for_conversation(conversation_id: str, user_id: str, session_factory: SessionFactory) -> bool:
    """The ``_finish_run`` safety net: wake once if a settled depth-1 task of
    this conversation is still unhandled. Returns True when a run was started.

    Cheap when there is nothing to do: the agents service is asked only when
    the mirror holds such a task.
    """
    async with session_factory() as db:
        candidates = await db.scalar(
            select(func.count())
            .select_from(ConversationTaskTable)
            .where(
                ConversationTaskTable.conversation_id == conversation_id,
                ConversationTaskTable.depth == 1,
                ConversationTaskTable.status.in_(TASK_SETTLED_STATUSES),
                ConversationTaskTable.notified_at.is_(None),
            )
        )
    if not candidates:
        return False
    try:
        items = await agents_list_unnotified(
            settings.async_tasks.unnotified_limit, user_id=user_id, conversation_id=conversation_id
        )
    except AgentsTaskError as exc:
        logger.warning("task_unnotified_fetch_failed", "Could not list unnotified tasks", error_type=str(exc))
        return False
    for item in items:
        outcome = await handle_outbox_item(item, session_factory)
        if outcome is WakeOutcome.WOKEN:
            return True
        if outcome in (WakeOutcome.BUSY, WakeOutcome.DEFERRED):
            return False
    return False


async def on_run_finished(run_id: str, session_factory: SessionFactory) -> None:
    """After every run: the queued message first, else one pending wake-up."""
    async with session_factory() as db:
        run = await db.get(MessageTable, run_id)
        conversation = await db.get(ConversationTable, run.conversation_id) if run is not None else None
        if conversation is None or conversation.is_trial:
            return
        conversation_id, user_id = conversation.id, conversation.user_id
        has_queued = conversation.queued_message is not None
    if has_queued and await send_queued_message(conversation_id, after_run_id=run_id, session_factory=session_factory):
        return
    if settings.async_tasks.enabled:
        await wake_pending_for_conversation(conversation_id, user_id, session_factory)


register_run_finished_hook(on_run_finished)


async def reconcile_once(session_factory: Optional[SessionFactory] = None) -> None:
    """One pass of the safety net: queued messages, then unnotified settles."""
    session_factory = session_factory or SessionLocal
    async with session_factory() as db:
        due = await pending_queue_conversations(
            db, older_than_seconds=settings.async_tasks.queue_sweep_after_seconds
        )
    for conversation_id in due:
        await send_queued_message(conversation_id, session_factory=session_factory)

    try:
        items = await agents_list_unnotified(settings.async_tasks.unnotified_limit)
    except AgentsTaskError as exc:
        logger.warning("task_reconcile_fetch_failed", "Could not list unnotified tasks", error_type=str(exc))
        return
    # One wake per conversation per pass: the run it starts pulls the rest.
    busy: set[str] = set()
    for item in items:
        if item.conversation_id in busy:
            continue
        outcome = await handle_outbox_item(item, session_factory)
        if outcome in (WakeOutcome.WOKEN, WakeOutcome.BUSY):
            busy.add(item.conversation_id)
    if items:
        logger.info("task_reconcile_done", "Reconciled unnotified tasks", count=len(items))
