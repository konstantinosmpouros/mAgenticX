"""Scheduled Tasks: CRUD, next-fire computation, the single-fire claim, the
headless fire path, and the in-process scheduler loop.

A scheduled task fires by reusing the normal inference pipeline
(``start_inference_flow`` + ``inference_run_manager.launch``), so a fire produces
an ordinary AI ``MessageTable`` row tagged with ``scheduled_task_id``. Nothing
here re-implements streaming, persistence, or the durable checkpointer — the run
completes and persists server-side whether or not a client is connected.

Single-fire safety: the bridge runs one replica, but ``order: start-first``
overlaps two containers for ~30s on every deploy, so a naive timer double-fires.
Due tasks are claimed with ``SELECT ... FOR UPDATE SKIP LOCKED`` and their
``next_run_at`` advanced + committed *before* firing, so two overlapping ticks
can never claim the same row and the row lock is never held across the agent call.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import (
    ConversationTable,
    MessageTable,
    ScheduledTaskTable,
    SessionLocal,
    UserTable,
)
from core.settings import settings
from core.logging import get_logger
from schemas import (
    InferenceStartPayload,
    MessageIn,
    ScheduledTaskCreate,
    ScheduledTaskOut,
    ScheduledTaskUpdate,
)
from utils.agents import get_agent_by_id
from utils.inference_runs import ACTIVE_RUN_STATUSES, inference_run_manager
from utils.inference_start import start_inference_flow

logger = get_logger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# -------------------------------------------------------------------------------
# Next-fire computation
# -------------------------------------------------------------------------------
def _next_cron(expr: str, tz: str | None, after: datetime) -> datetime | None:
    """Next cron fire strictly after ``after`` (naive UTC in, naive UTC out).

    croniter is computed in the task's IANA timezone so a "08:00" rule means
    08:00 *local*, then the result is converted back to naive UTC for storage.
    Lazily imported so this module loads even where croniter isn't installed.
    """
    try:
        from croniter import croniter
    except ImportError:
        logger.error("croniter_missing", "croniter is not installed; cannot compute cron next-fire")
        return None
    zone = timezone.utc
    if tz:
        try:
            from zoneinfo import ZoneInfo

            zone = ZoneInfo(tz)
        except Exception:
            zone = timezone.utc
    base = after.replace(tzinfo=timezone.utc).astimezone(zone)
    nxt = croniter(expr, base).get_next(datetime)
    return nxt.astimezone(timezone.utc).replace(tzinfo=None)


def compute_next_run_at(
    kind: str, spec: dict, tz: str | None, *, after: datetime
) -> datetime | None:
    """The next fire strictly after ``after``, or None when the schedule is spent.

    Recurring kinds advance from ``after`` (the actual fire time), so a long
    downtime produces exactly one catch-up fire then resyncs — missed ticks are
    skipped, never backfilled.
    """
    if kind == "one_off":
        raw = (spec or {}).get("run_at")
        if not raw:
            return None
        try:
            run_at = datetime.fromisoformat(raw)
        except (TypeError, ValueError):
            return None
        if run_at.tzinfo is not None:
            run_at = run_at.astimezone(timezone.utc).replace(tzinfo=None)
        return run_at if run_at > after else None
    if kind == "interval":
        seconds = int((spec or {}).get("interval_seconds") or 0)
        return after + timedelta(seconds=seconds) if seconds > 0 else None
    if kind == "cron":
        expr = (spec or {}).get("cron_expr")
        return _next_cron(expr, tz, after) if expr else None
    return None


def _schedule_spec_from_payload(payload: "ScheduledTaskCreate | ScheduledTaskUpdate") -> dict:
    if payload.scheduleKind == "one_off":
        return {"run_at": payload.runAt.isoformat()}
    if payload.scheduleKind == "interval":
        return {"interval_seconds": payload.intervalSeconds}
    return {"cron_expr": payload.cronExpr}


# -------------------------------------------------------------------------------
# CRUD
# -------------------------------------------------------------------------------
async def create_scheduled_task(
    db: AsyncSession, user: UserTable, create: ScheduledTaskCreate
) -> ScheduledTaskTable:
    existing = await db.scalar(
        select(func.count())
        .select_from(ScheduledTaskTable)
        .where(
            ScheduledTaskTable.user_id == user.id,
            ScheduledTaskTable.status.in_(["active", "paused"]),
        )
    )
    if existing is not None and existing >= settings.scheduler.max_tasks_per_user:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"You can have at most {settings.scheduler.max_tasks_per_user} scheduled tasks. Delete one first.",
        )

    agent = await get_agent_by_id(create.agentId)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown or inactive agent.")

    spec = _schedule_spec_from_payload(create)
    next_run = compute_next_run_at(create.scheduleKind, spec, create.timezone, after=_now())

    task = ScheduledTaskTable(
        user_id=user.id,
        agent_id=agent.id,
        agent_name=agent.name,
        agent_slug=agent.slug,
        target_mode=create.targetMode,
        title=create.title,
        prompt=create.prompt,
        is_private=create.isPrivate,
        schedule_kind=create.scheduleKind,
        schedule_spec=spec,
        timezone=create.timezone,
        status="active",
        next_run_at=next_run,
        max_runs=create.maxRuns,
        expires_at=create.expiresAt,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


async def list_scheduled_tasks_for_user(db: AsyncSession, user_id: str) -> list[ScheduledTaskTable]:
    result = await db.execute(
        select(ScheduledTaskTable)
        .where(ScheduledTaskTable.user_id == user_id)
        .order_by(ScheduledTaskTable.created_at.desc())
    )
    return list(result.scalars().all())


async def get_scheduled_task(db: AsyncSession, user_id: str, task_id: str) -> ScheduledTaskTable | None:
    result = await db.execute(
        select(ScheduledTaskTable).where(
            ScheduledTaskTable.id == task_id,
            ScheduledTaskTable.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


async def update_scheduled_task(
    db: AsyncSession, task: ScheduledTaskTable, update: ScheduledTaskUpdate
) -> ScheduledTaskTable:
    if update.title is not None:
        task.title = update.title
    if update.prompt is not None:
        task.prompt = update.prompt
    if update.agentId is not None:
        agent = await get_agent_by_id(update.agentId)
        if agent is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown or inactive agent.")
        task.agent_id = agent.id
        task.agent_name = agent.name
        task.agent_slug = agent.slug
    if update.targetMode is not None:
        task.target_mode = update.targetMode
        # Switching back to 'fresh' drops the bound pointer so each fire mints its own conversation.
        if update.targetMode == "fresh":
            task.conversation_id = None
    if update.isPrivate is not None:
        task.is_private = update.isPrivate
    if update.maxRuns is not None:
        task.max_runs = update.maxRuns
    if update.expiresAt is not None:
        task.expires_at = update.expiresAt
    # Cadence change: re-derive the schedule + next fire (and revive a spent task).
    if update.scheduleKind is not None:
        task.schedule_kind = update.scheduleKind
        task.schedule_spec = _schedule_spec_from_payload(update)
        task.timezone = update.timezone if update.scheduleKind == "cron" else None
        task.next_run_at = compute_next_run_at(
            task.schedule_kind, task.schedule_spec, task.timezone, after=_now()
        )
        if task.next_run_at is None:
            task.status = "completed"
        elif task.status in ("completed", "failed"):
            task.status = "active"
            task.last_error = None
    # Status (pause/resume) is applied last so an explicit choice wins over the
    # cadence-edit reactivation above.
    if update.status is not None:
        if update.status == "paused" and task.status == "active":
            task.status = "paused"
        elif update.status == "active" and task.status in ("paused", "failed"):
            task.status = "active"
            task.last_error = None
            if task.next_run_at is None or task.next_run_at <= _now():
                task.next_run_at = compute_next_run_at(
                    task.schedule_kind, task.schedule_spec or {}, task.timezone, after=_now()
                )
                if task.next_run_at is None:
                    # A one-off whose moment has passed can't be resumed.
                    task.status = "completed"
    await db.commit()
    await db.refresh(task)
    return task


async def delete_scheduled_task(db: AsyncSession, task: ScheduledTaskTable) -> None:
    await db.delete(task)
    await db.commit()


# -------------------------------------------------------------------------------
# Serialization (live status derived from the latest fire's message)
# -------------------------------------------------------------------------------
async def hydrate_live_status(
    db: AsyncSession, tasks: list[ScheduledTaskTable]
) -> dict[str, tuple[str | None, str | None]]:
    """Map task id -> (live run status, result conversation id) by looking up each
    task's ``last_run_message_id``. One batched query; the message's
    ``streaming_status`` is the authoritative current state of the latest fire."""
    message_ids = [t.last_run_message_id for t in tasks if t.last_run_message_id]
    if not message_ids:
        return {}
    rows = await db.execute(
        select(MessageTable.id, MessageTable.streaming_status, MessageTable.conversation_id).where(
            MessageTable.id.in_(message_ids)
        )
    )
    by_message = {row.id: (row.streaming_status, row.conversation_id) for row in rows.all()}
    resolved: dict[str, tuple[str | None, str | None]] = {}
    for task in tasks:
        if task.last_run_message_id and task.last_run_message_id in by_message:
            resolved[task.id] = by_message[task.last_run_message_id]
    return resolved


def build_scheduled_task_out(
    task: ScheduledTaskTable, live: tuple[str | None, str | None] | None = None
) -> ScheduledTaskOut:
    out = ScheduledTaskOut.model_validate(task)
    if live is not None:
        out.liveStatus, out.lastRunConversationId = live
    return out


# -------------------------------------------------------------------------------
# Claim + fire
# -------------------------------------------------------------------------------
async def claim_due_tasks(db: AsyncSession, limit: int) -> list[str]:
    """Atomically claim up to ``limit`` due active tasks, advance their schedule,
    and commit before returning their ids to fire. ``FOR UPDATE SKIP LOCKED``
    means a concurrent tick (deploy overlap) can never claim the same row."""
    now = _now()
    result = await db.execute(
        select(ScheduledTaskTable)
        .where(
            ScheduledTaskTable.status == "active",
            ScheduledTaskTable.next_run_at.is_not(None),
            ScheduledTaskTable.next_run_at <= now,
        )
        .order_by(ScheduledTaskTable.next_run_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    tasks = list(result.scalars().all())
    claimed: list[str] = []
    for task in tasks:
        task.last_run_at = now
        task.run_count = (task.run_count or 0) + 1
        nxt = compute_next_run_at(task.schedule_kind, task.schedule_spec or {}, task.timezone, after=now)
        reached_max = task.max_runs is not None and task.run_count >= task.max_runs
        past_expiry = nxt is not None and task.expires_at is not None and nxt > task.expires_at
        if nxt is None or reached_max or past_expiry:
            task.next_run_at = None
            task.status = "completed"
        else:
            task.next_run_at = nxt
        claimed.append(task.id)
    await db.commit()
    return claimed


async def _load_owned_conversation(
    db: AsyncSession, user_id: str, conversation_id: str
) -> ConversationTable | None:
    result = await db.execute(
        select(ConversationTable)
        .options(selectinload(ConversationTable.messages))
        .where(ConversationTable.id == conversation_id, ConversationTable.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def fire_scheduled_task(task_id: str) -> None:
    """Fire one already-claimed task: build the start payload, run it through the
    normal inference pipeline tagged with the task id, then launch it detached."""
    run_id: str | None = None
    async with SessionLocal() as db:
        task = await db.get(ScheduledTaskTable, task_id)
        if task is None:
            return

        # Skip if a prior fire of this task is still streaming (no overlap).
        active_existing = await db.scalar(
            select(MessageTable.id)
            .where(
                MessageTable.scheduled_task_id == task.id,
                MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
            )
            .limit(1)
        )
        if active_existing is not None:
            task.last_run_status = "skipped"
            task.last_error = "Previous run was still in progress; this fire was skipped."
            await db.commit()
            return

        user = await db.get(UserTable, task.user_id)
        if user is None:
            return  # the row will cascade-delete with the user

        agent = await get_agent_by_id(task.agent_id) if task.agent_id else None
        if agent is None:
            task.status = "failed"
            task.last_run_status = "failed"
            task.last_error = "The task's agent is no longer available."
            await db.commit()
            return

        message = MessageIn(sender="user", content=task.prompt)

        if task.target_mode == "bound" and task.conversation_id:
            conv = await _load_owned_conversation(db, user.id, task.conversation_id)
            if conv is None:
                task.status = "paused"
                task.conversation_id = None
                task.last_run_status = "failed"
                task.last_error = "The bound conversation was deleted; the task was paused."
                await db.commit()
                return
            leaf = conv.messages[-1] if conv.messages else None
            if leaf is None:
                task.status = "paused"
                task.last_run_status = "failed"
                task.last_error = "The bound conversation has no messages to continue from."
                await db.commit()
                return
            payload = InferenceStartPayload(
                mode="send",
                agentId=agent.id,
                conversationId=conv.id,
                parentMessageId=leaf.id,
                message=message,
            )
        else:
            payload = InferenceStartPayload(
                mode="new",
                agentId=agent.id,
                isPrivate=task.is_private,
                title=task.title,
                message=message,
            )

        # Capture before start_inference_flow: it calls db.expire_all(), leaving
        # `task` expired — reading its ORM attrs afterward would trigger lazy IO
        # on the async session (MissingGreenlet). We reload the row below instead.
        target_mode = task.target_mode
        has_bound_conversation = bool(task.conversation_id)
        try:
            response = await start_inference_flow(
                db=db, user=user, payload=payload, scheduled_task_id=task.id
            )
        except (HTTPException, IntegrityError) as exc:
            await db.rollback()
            task = await db.get(ScheduledTaskTable, task_id)
            if task is not None:
                code = getattr(exc, "status_code", None)
                task.last_run_status = "skipped" if code in (409, 429) else "failed"
                task.last_error = str(getattr(exc, "detail", exc))
                await db.commit()
            return

        run_id = response.run.id
        task = await db.get(ScheduledTaskTable, task_id)
        if task is None:
            return
        if target_mode == "bound" and not has_bound_conversation:
            task.conversation_id = response.run.conversationId
        task.last_run_message_id = run_id
        task.last_run_status = "running"
        task.last_error = None
        await db.commit()

    if run_id is not None:
        inference_run_manager.launch(run_id)


async def reap_timed_out_fires() -> None:
    """Cancel scheduled runs that have streamed past the watchdog timeout. This is
    the guard against a headless run hanging forever on a HITL approval gate — the
    resume signal only ever comes from a live client, which a schedule has none of."""
    cutoff = _now() - timedelta(seconds=settings.scheduler.run_timeout_seconds)
    async with SessionLocal() as db:
        result = await db.execute(
            select(ScheduledTaskTable)
            .join(MessageTable, MessageTable.id == ScheduledTaskTable.last_run_message_id)
            .where(
                ScheduledTaskTable.last_run_message_id.is_not(None),
                ScheduledTaskTable.last_run_at < cutoff,
                MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
            )
        )
        tasks = list(result.scalars().all())
        for task in tasks:
            inference_run_manager.request_cancel(task.last_run_message_id)
            task.last_run_status = "failed"
            task.last_error = "The run exceeded the scheduled-task time limit (it may have hit an approval gate)."
        if tasks:
            await db.commit()


async def _mark_fire_error(task_id: str, detail: str) -> None:
    async with SessionLocal() as db:
        task = await db.get(ScheduledTaskTable, task_id)
        if task is not None:
            task.last_run_status = "failed"
            task.last_error = detail
            await db.commit()


# -------------------------------------------------------------------------------
# The scheduler loop (started/stopped by the FastAPI lifespan)
# -------------------------------------------------------------------------------
class Scheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if not settings.scheduler.enabled:
            logger.info("scheduler_disabled", "Scheduler is disabled (SCHEDULER_ENABLED=false)")
            return
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop())
        logger.info(
            "scheduler_started",
            "Scheduled-tasks loop started",
            poll_interval_seconds=settings.scheduler.poll_interval_seconds,
        )

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        self._task = None
        logger.info("scheduler_stopped", "Scheduled-tasks loop stopped")

    async def _loop(self) -> None:
        interval = settings.scheduler.poll_interval_seconds
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("scheduler_tick_failed", "Scheduler tick failed", exc_info=True)
            await asyncio.sleep(interval)

    async def _tick(self) -> None:
        try:
            await reap_timed_out_fires()
        except Exception:
            logger.error("scheduler_reap_failed", "Timeout reap failed", exc_info=True)

        async with SessionLocal() as db:
            claimed = await claim_due_tasks(db, settings.scheduler.claim_batch_size)
        if claimed:
            logger.info("scheduler_claimed", "Claimed due scheduled tasks", count=len(claimed))
        for task_id in claimed:
            try:
                await fire_scheduled_task(task_id)
            except Exception:
                logger.error("scheduled_fire_failed", "Scheduled task fire failed", exc_info=True, task_id=task_id)
                try:
                    await _mark_fire_error(task_id, "The scheduled run could not be started.")
                except Exception:
                    logger.error("scheduled_fire_mark_failed", "Could not record fire failure", exc_info=True, task_id=task_id)


scheduler = Scheduler()
