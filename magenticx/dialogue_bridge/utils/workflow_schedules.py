"""Workflow schedules (plan 38 §3.9): a workflow scheduled by its start node.

A workflow's schedule lives on its ``trigger.schedule`` start node, in the spec
the agents service stores — that node is the **source of truth**. The bridge
keeps one ``workflow_schedules`` row per scheduled workflow, the
materialisation its scheduler polls:

* **Sync** (:func:`sync_workflow_schedule`) runs after the agents service has
  accepted a create or update: the saved spec's trigger is read back
  (:func:`desired_schedule`); an enabled ``trigger.schedule`` upserts the row,
  anything else deletes it. ``next_run_at`` is recomputed only when the cadence
  changed, and a paused schedule stays paused. The agents call comes first and
  is the commit point; a failed sync is logged, never turned into a failed
  save, and is healed at the next save or at the next fire.
* **Fire** (:func:`run_due_workflow_schedules`, called from the scheduled-tasks
  loop): due rows are claimed ``FOR UPDATE SKIP LOCKED`` and their
  ``next_run_at`` advanced and committed **before** firing, exactly like
  scheduled tasks. Each fire re-reads the workflow upstream first: a deleted
  workflow drops the row, a spec whose schedule changed re-syncs it instead of
  firing. A fire is an ordinary run (``trigger_kind = 'schedule'``) through
  :func:`utils.workflow_runs.start_workflow_run`; while the workflow already
  has a live run the fire is recorded ``skipped``. A one-off is ``finished``
  once fired. A fire passes no inputs: the engine fills each of the spec's
  ``inputs`` from its default (a legacy ``inputs`` on the trigger config is
  ignored).

Kept out of ``scheduled_tasks`` on purpose: the Automations → Schedules list
(agent + prompt schedules) never mixes the two, and a workflow schedule is
edited in the builder, not there — the API here only pauses and resumes it.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import delete, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

# Module objects, not names: utils.scheduled_tasks calls into this module from
# its loop, so a ``from`` import in either direction would be circular.
import utils.scheduled_tasks as scheduled_tasks
from core.database import SessionLocal, WorkflowRunTable, WorkflowScheduleTable
from core.logging import get_logger
from core.settings import settings
from schema import (
    SCHEDULE_TRIGGER_KIND,
    WorkflowOut,
    WorkflowScheduleOut,
    WorkflowScheduleTrigger,
)
from utils.account_status import open_deletion_exists_for
from utils.workflow_runs import launch_or_fail, start_workflow_run
from utils.workflows import get_workflow

# Optional at import, as in schema.scheduled_tasks: on a bare host without
# croniter or a tz database, cron and zone checks are skipped (the container
# carries both and checks strictly).
try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:
    ZoneInfo = None
    ZoneInfoNotFoundError = None
try:
    from croniter import croniter
except ImportError:
    croniter = None

logger = get_logger(__name__)

#: ``last_run_status`` of a fire that created a run — the run then carries the
#: real status (see :func:`_schedule_out`).
STARTED = "started"


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# Reading the schedule out of a saved spec
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class DesiredSchedule:
    """What the spec says the workflow's row should be (scheduled-task shapes)."""

    node_id: str
    kind: str
    spec: dict[str, Any]
    timezone: str | None

    def same_cadence(self, row: WorkflowScheduleTable) -> bool:
        """Whether the row already runs on this cadence."""
        return (
            row.schedule_kind == self.kind
            and (row.schedule_spec or {}) == self.spec
            and row.timezone == self.timezone
        )


def _trigger_node(spec: dict[str, Any] | None) -> dict[str, Any] | None:
    """The spec's ``trigger.schedule`` node, if it has one."""
    nodes = (spec or {}).get("nodes")
    if not isinstance(nodes, list):
        return None
    for node in nodes:
        if isinstance(node, dict) and node.get("kind") == SCHEDULE_TRIGGER_KIND:
            return node
    return None


def _valid_zone(name: str) -> bool:
    if ZoneInfo is None:
        return True
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


def desired_schedule(spec: dict[str, Any] | None) -> DesiredSchedule | None:
    """The schedule a saved spec asks for, or ``None`` (no enabled schedule).

    Fail-closed: a trigger config that does not parse, or a cadence the
    bridge's own rules refuse (an invalid cron or zone), schedules nothing and
    is logged — never a guess. The interval floor is applied as a clamp, so the
    bridge's ``SCHEDULER_MIN_INTERVAL_SECONDS`` holds even if it is stricter
    than the engine's.
    """
    node = _trigger_node(spec)
    if node is None:
        return None
    node_id = node.get("id")
    try:
        trigger = WorkflowScheduleTrigger.model_validate(node.get("config") or {})
    except ValidationError:
        logger.warning("workflow_schedule_unreadable", "A trigger.schedule config could not be read",
                       node_id=str(node_id)[:64])
        return None
    if not trigger.enabled or not isinstance(node_id, str) or not node_id:
        return None
    given = trigger.schedule_spec
    timezone_value: str | None = None
    if trigger.schedule_kind == "one_off":
        if given.run_at is None:
            return None
        run_at = given.run_at
        if run_at.tzinfo is not None:
            run_at = run_at.astimezone(UTC).replace(tzinfo=None)
        schedule = {"run_at": run_at.isoformat()}
    elif trigger.schedule_kind == "interval":
        if given.interval_seconds is None:
            return None
        schedule = {"interval_seconds": max(given.interval_seconds, settings.scheduler.min_interval_seconds)}
    else:
        expr = (given.cron_expr or "").strip()
        timezone_value = (trigger.timezone or "").strip() or "UTC"
        if not expr or (croniter is not None and not croniter.is_valid(expr)) or not _valid_zone(timezone_value):
            logger.warning("workflow_schedule_rejected", "A cron trigger.schedule was refused by the bridge",
                           node_id=node_id[:64])
            return None
        schedule = {"cron_expr": expr}
    return DesiredSchedule(
        node_id=node_id,
        kind=trigger.schedule_kind,
        spec=schedule,
        timezone=timezone_value,
    )


# ---------------------------------------------------------------------------
# Sync (definitions proxy)
# ---------------------------------------------------------------------------
def _next_run(desired: DesiredSchedule) -> datetime | None:
    return scheduled_tasks.compute_next_run_at(desired.kind, desired.spec, desired.timezone, after=_now())


async def _apply(
    db: AsyncSession, user_id: str, workflow_id: str, desired: DesiredSchedule | None
) -> None:
    """Make the row match ``desired`` (no commit). ``None`` deletes it."""
    row = await db.get(WorkflowScheduleTable, workflow_id)
    if row is not None and row.user_id != user_id:
        # Workflow ids are upstream UUIDs, so this cannot happen by accident;
        # refuse rather than touch another user's row.
        logger.error("workflow_schedule_owner_mismatch", "A workflow schedule belongs to another user",
                     workflow_id=workflow_id)
        return
    if desired is None:
        if row is not None:
            await db.delete(row)
        return
    if row is None:
        next_run = _next_run(desired)
        db.add(WorkflowScheduleTable(
            workflow_id=workflow_id,
            user_id=user_id,
            node_id=desired.node_id,
            schedule_kind=desired.kind,
            schedule_spec=desired.spec,
            timezone=desired.timezone,
            inputs={},  # kept column; a fire passes no inputs
            status="active" if next_run is not None else "finished",
            next_run_at=next_run,
            run_count=0,
        ))
        return
    row.node_id = desired.node_id
    row.inputs = {}  # clears what an older row stored
    if desired.same_cadence(row):
        return  # keep next_run_at and status: a re-save does not reset the clock
    row.schedule_kind = desired.kind
    row.schedule_spec = desired.spec
    row.timezone = desired.timezone
    row.next_run_at = _next_run(desired)
    if row.next_run_at is None:
        row.status = "finished"
    elif row.status == "finished":
        row.status = "active"  # a new cadence revives a spent schedule
    # 'paused' stays paused: only the user resumes it.


async def sync_workflow_schedule(db: AsyncSession, user_id: str, workflow: WorkflowOut) -> WorkflowOut:
    """Materialise a just-saved workflow's schedule; returns it with ``schedule`` set.

    Runs after the agents service accepted the save, which is the commit point:
    a database failure here is logged and the save still succeeds — the row is
    healed by the next save, or by the next fire's re-read of the spec.
    """
    try:
        await _apply(db, user_id, workflow.id, desired_schedule(workflow.spec))
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        logger.error("workflow_schedule_sync_failed", "Could not sync a workflow schedule",
                     workflow_id=workflow.id, exc_info=True)
    return (await attach_schedules(db, user_id, [workflow]))[0]


async def delete_workflow_schedule(db: AsyncSession, user_id: str, workflow_id: str) -> None:
    """Drop a workflow's schedule (the workflow was deleted upstream)."""
    await db.execute(
        delete(WorkflowScheduleTable).where(
            WorkflowScheduleTable.workflow_id == workflow_id, WorkflowScheduleTable.user_id == user_id
        )
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Reading (WorkflowOut.schedule) and pause / resume
# ---------------------------------------------------------------------------
def _schedule_out(row: WorkflowScheduleTable, run_status: str | None) -> WorkflowScheduleOut:
    """The row as the API shows it; a started fire reports its run's status."""
    out = WorkflowScheduleOut.model_validate(row)
    if row.last_run_status == STARTED:
        out.lastRunStatus = run_status
    return out


async def _rows_with_run_status(
    db: AsyncSession, user_id: str, workflow_ids: list[str]
) -> dict[str, WorkflowScheduleOut]:
    """One query for many workflows: each row joined to its newest fire's run."""
    if not workflow_ids:
        return {}
    rows = await db.execute(
        select(WorkflowScheduleTable, WorkflowRunTable.status)
        .outerjoin(
            WorkflowRunTable,
            (WorkflowRunTable.id == WorkflowScheduleTable.last_run_id)
            & (WorkflowRunTable.user_id == WorkflowScheduleTable.user_id),
        )
        .where(WorkflowScheduleTable.user_id == user_id, WorkflowScheduleTable.workflow_id.in_(workflow_ids))
    )
    return {row.workflow_id: _schedule_out(row, run_status) for row, run_status in rows.all()}


async def attach_schedules(db: AsyncSession, user_id: str, workflows: list[WorkflowOut]) -> list[WorkflowOut]:
    """Set each workflow's ``schedule`` (``None`` when it has none) — one query."""
    found = await _rows_with_run_status(db, user_id, [w.id for w in workflows])
    return [w.model_copy(update={"schedule": found.get(w.id)}) for w in workflows]


async def set_schedule_paused(
    db: AsyncSession, user_id: str, workflow_id: str, *, paused: bool
) -> WorkflowScheduleOut:
    """Pause or resume a workflow's schedule. 404 when it has none.

    Pausing is idempotent and leaves a ``finished`` schedule alone. Resuming
    re-arms the next slot from now when the stored one has passed (missed slots
    are skipped, never backfilled); a one-off whose moment has gone becomes
    ``finished``.
    """
    row = (
        await db.execute(
            select(WorkflowScheduleTable).where(
                WorkflowScheduleTable.workflow_id == workflow_id, WorkflowScheduleTable.user_id == user_id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This workflow has no schedule.")
    if paused and row.status == "active":
        row.status = "paused"
    elif not paused and row.status == "paused":
        row.status = "active"
        if row.next_run_at is None or row.next_run_at <= _now():
            row.next_run_at = scheduled_tasks.compute_next_run_at(
                row.schedule_kind, row.schedule_spec or {}, row.timezone, after=_now()
            )
            if row.next_run_at is None:
                row.status = "finished"
    await db.commit()
    logger.info("workflow_schedule_status", "Workflow schedule paused or resumed",
                workflow_id=workflow_id, status=row.status)
    return (await _rows_with_run_status(db, user_id, [workflow_id]))[workflow_id]


# ---------------------------------------------------------------------------
# Claim + fire (scheduler loop)
# ---------------------------------------------------------------------------
async def claim_due_workflow_schedules(db: AsyncSession, limit: int) -> list[str]:
    """Claim up to ``limit`` due schedules, advance them, commit; return their ids.

    ``FOR UPDATE SKIP LOCKED`` keeps two overlapping ticks (a start-first
    deploy) from claiming the same row, and committing before the fire means
    the lock is never held across the upstream call. A user awaiting account
    deletion is frozen: their rows are skipped, not modified.
    """
    now = _now()
    rows = list(
        (
            await db.execute(
                select(WorkflowScheduleTable)
                .where(
                    WorkflowScheduleTable.status == "active",
                    WorkflowScheduleTable.next_run_at.is_not(None),
                    WorkflowScheduleTable.next_run_at <= now,
                    ~open_deletion_exists_for(WorkflowScheduleTable.user_id),
                )
                .order_by(WorkflowScheduleTable.next_run_at.asc())
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    for row in rows:
        row.last_run_at = now
        row.run_count = (row.run_count or 0) + 1
        row.next_run_at = scheduled_tasks.compute_next_run_at(
            row.schedule_kind, row.schedule_spec or {}, row.timezone, after=now
        )
        if row.next_run_at is None:
            row.status = "finished"  # a one-off, now spent
    await db.commit()
    return [row.workflow_id for row in rows]


async def _record(workflow_id: str, outcome: str) -> None:
    """Note a fire that produced no run (``skipped`` | ``failed``)."""
    async with SessionLocal() as db:
        await db.execute(
            update(WorkflowScheduleTable)
            .where(WorkflowScheduleTable.workflow_id == workflow_id)
            .values(last_run_status=outcome, updated_at=_now())
        )
        await db.commit()


async def fire_workflow_schedule(workflow_id: str) -> None:
    """Fire one claimed schedule: re-read the workflow, then start its run.

    The upstream read happens with no database session open. It is the fire's
    reference check: a workflow that is gone drops its row, and a spec whose
    schedule no longer matches the row (a sync that failed, a disabled
    trigger) re-syncs the row instead of firing on stale data.
    """
    async with SessionLocal() as db:
        row = await db.get(WorkflowScheduleTable, workflow_id)
        if row is None:
            return
        user_id = row.user_id

    try:
        workflow = await get_workflow(user_id, workflow_id)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            async with SessionLocal() as db:
                await delete_workflow_schedule(db, user_id, workflow_id)
            logger.info("workflow_schedule_orphaned", "Dropped the schedule of a workflow that is gone",
                        workflow_id=workflow_id)
        else:
            await _record(workflow_id, "failed")
            logger.warning("workflow_schedule_fire_unavailable", "Could not read a scheduled workflow",
                           workflow_id=workflow_id, status_code=exc.status_code)
        return

    desired = desired_schedule(workflow.spec)
    run_id: str | None = None
    async with SessionLocal() as db:
        row = await db.get(WorkflowScheduleTable, workflow_id)
        if row is None:
            return
        if desired is None or not desired.same_cadence(row) or row.node_id != desired.node_id:
            await _apply(db, user_id, workflow_id, desired)
            await db.commit()
            logger.info("workflow_schedule_resynced", "A workflow schedule was re-synced from its spec at fire time",
                        workflow_id=workflow_id, scheduled=desired is not None)
            return
        try:
            run = await start_workflow_run(
                db, user_id, workflow_id, {}, trigger_kind="schedule", workflow=workflow
            )
        except HTTPException as exc:
            await db.rollback()
            # 409: the workflow already has a live run; 429: the user's cap on
            # runs in progress. Both wait for the next slot.
            outcome = "skipped" if exc.status_code in (status.HTTP_409_CONFLICT, 429) else "failed"
            await _record(workflow_id, outcome)
            logger.info("workflow_schedule_fire_not_started", "A scheduled workflow fire did not start a run",
                        workflow_id=workflow_id, outcome=outcome, status_code=exc.status_code)
            return
        run_id = run.id
        await db.execute(
            update(WorkflowScheduleTable)
            .where(WorkflowScheduleTable.workflow_id == workflow_id)
            .values(last_run_id=run_id, last_run_status=STARTED, updated_at=_now())
        )
        await db.commit()
    logger.info("workflow_schedule_fired", "Scheduled workflow run started", workflow_id=workflow_id, run_id=run_id)
    await launch_or_fail(run_id)


async def run_due_workflow_schedules() -> int:
    """One scheduler tick's worth: claim due schedules and fire each. Returns
    how many were claimed. A failing fire is logged and recorded; it never
    stops the others."""
    async with SessionLocal() as db:
        claimed = await claim_due_workflow_schedules(db, settings.scheduler.claim_batch_size)
    for workflow_id in claimed:
        try:
            await fire_workflow_schedule(workflow_id)
        except Exception:
            logger.error("workflow_schedule_fire_failed", "Scheduled workflow fire failed",
                         workflow_id=workflow_id, exc_info=True)
            try:
                await _record(workflow_id, "failed")
            except SQLAlchemyError:
                logger.error("workflow_schedule_mark_failed", "Could not record a failed workflow fire",
                             workflow_id=workflow_id, exc_info=True)
    return len(claimed)


__all__ = [
    "DesiredSchedule",
    "attach_schedules",
    "claim_due_workflow_schedules",
    "delete_workflow_schedule",
    "desired_schedule",
    "fire_workflow_schedule",
    "run_due_workflow_schedules",
    "set_schedule_paused",
    "sync_workflow_schedule",
]
