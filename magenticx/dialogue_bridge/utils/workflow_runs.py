"""Workflow runs (plan 38, step 1): start, persist, fan out, resume, cancel.

A workflow run is its own entity — a ``workflow_runs`` row and every AG-UI
event the engine emitted, in order, in ``workflow_run_events`` — so the UI can
show a run list, a graph + timeline of node executions and each execution's
details, for history and live alike.

How a run goes (one **leg** = one streaming call to the agents service):

1. :func:`start_workflow_run` checks the workflow upstream (ownership, name,
   latest version), enforces the caps and inserts the row ``queued``. The
   unique partial index ``uq_workflow_runs_one_live`` makes "one live run per
   workflow per user" hold even under racing starts (the loser gets a 409).
2. :class:`WorkflowRunManager` runs the leg in the background: a reader task
   consumes ``POST /workflows/runs/stream`` (SSE) into a bounded queue; the
   writer assigns each event the next ``seq``, buffers it, and persists the
   buffer in one short transaction every ``WORKFLOW_RUN_PERSIST_BATCH`` events
   or ``WORKFLOW_RUN_PERSIST_INTERVAL_MS``, **then** publishes it to the run's
   Redis stream. Persist-before-publish is what makes the event stream
   gap-free: anything a live viewer sees in Redis is already in the database.
3. The leg ends: ``RUN_ERROR`` → ``failed``; the HITL interrupt → ``waiting``
   (the agents stream has ended; nothing is held in memory, so a waiting run
   survives a bridge restart); ``RUN_FINISHED`` → ``succeeded``; a stream that
   just stops → ``failed``.
4. :func:`resume_workflow_run` flips ``waiting`` → ``running`` (compare-and-set,
   so two answers cannot both win) and starts a new leg on the same
   ``thread_id`` with the decision.

Every status write is a compare-and-set on the status the writer expects, and
every persist batch re-checks that the row is still ``running`` in the same
transaction. That is how a cancel or the watchdog — possibly on another replica
— stops a leg: the leg's next write finds the row no longer running and stops.

The watchdog (:func:`run_workflow_watchdog`) fails a leg that has persisted
nothing for ``WORKFLOW_RUN_STREAM_IDLE_TIMEOUT_SECONDS`` and expires a
``waiting`` run after ``WORKFLOW_APPROVAL_TTL_HOURS``.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
from fastapi import HTTPException, status
from sqlalchemy import and_, delete, func, insert, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import SessionLocal, WorkflowRunEventTable, WorkflowRunTable
from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from schema import (
    WorkflowOut,
    WorkflowRunDetail,
    WorkflowRunEventOut,
    WorkflowRunOut,
    WorkflowRunPage,
    WorkflowTriggerKind,
)
from utils.event_log import RedisEventLog
from utils.inference_runs import _parse_sse_bytes
from utils.workflows import get_workflow, workflows_base_url

logger = get_logger(__name__)

#: Statuses that hold the workflow's one live slot.
LIVE_STATUSES = ("queued", "running", "waiting")
#: Statuses with a leg streaming (or about to): what the per-user cap counts.
ACTIVE_STATUSES = ("queued", "running")
TERMINAL_STATUSES = ("succeeded", "failed", "cancelled")
#: A live event stream closes on these: the run ended, or paused for approval.
TAIL_END_STATUSES = frozenset({"waiting", *TERMINAL_STATUSES})

#: The engine's approval pause — the same custom event chat runs use.
HITL_INTERRUPT = "HITL_INTERRUPT"
#: Bridge-written events (never from the engine), so the timeline shows them.
TRUNCATION_MARKER = "bridge.events_truncated"
DECISION_MARKER = "bridge.approval_decision"
#: Still persisted after the per-run event cap: what decides the run's outcome.
_KEPT_PAST_CAP = frozenset({"RUN_STARTED", "RUN_FINISHED", "RUN_ERROR"})

#: Longest id lifted from an event's ``workflow`` block into an indexed column.
_MAX_ID_CHARS = 200
#: Upper bound on the reader → writer queue: a fast stream waits for the DB.
_QUEUE_SIZE = 1000
#: Events read per DB page when replaying a run's history.
_REPLAY_PAGE = 500
#: Most events one run-detail response carries; the rest come by ``after_seq``.
DETAIL_EVENT_PAGE = 5000

workflow_event_log = RedisEventLog(key_prefix="workflow:run")


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def run_out(run: WorkflowRunTable) -> WorkflowRunOut:
    return WorkflowRunOut.model_validate(run)


def _status_frame(run: WorkflowRunTable) -> dict[str, Any]:
    """The live frame for a status change; ``run.status`` is what the Redis
    tail (``RedisEventLog.read_since``) checks to know a leg has closed."""
    return {"type": "status", "run": run_out(run).model_dump(mode="json")}


# ---------------------------------------------------------------------------
# Queries scoped to the owner
# ---------------------------------------------------------------------------
async def get_run_for_user(db: AsyncSession, user_id: str, run_id: str) -> WorkflowRunTable | None:
    """A run of this user's, or ``None`` — someone else's run is a 404 to the router."""
    return (
        await db.execute(
            select(WorkflowRunTable).where(WorkflowRunTable.id == run_id, WorkflowRunTable.user_id == user_id)
        )
    ).scalar_one_or_none()


def _encode_cursor(run: WorkflowRunTable) -> str:
    raw = json.dumps([run.created_at.isoformat(), run.id]).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        created, run_id = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        return datetime.fromisoformat(created), str(run_id)
    except (ValueError, TypeError, binascii.Error, UnicodeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cursor.") from exc


async def list_runs(db: AsyncSession, user_id: str, workflow_id: str, cursor: str | None) -> WorkflowRunPage:
    """One workflow's runs, newest first, keyset-paged on ``(created_at, id)``.

    A keyset rather than an offset: a page never shifts when new runs start
    while the user scrolls.
    """
    size = settings.workflows.runs_page_size
    query = select(WorkflowRunTable).where(
        WorkflowRunTable.user_id == user_id, WorkflowRunTable.workflow_id == workflow_id
    )
    if cursor:
        created, after_id = _decode_cursor(cursor)
        query = query.where(
            or_(
                WorkflowRunTable.created_at < created,
                and_(WorkflowRunTable.created_at == created, WorkflowRunTable.id < after_id),
            )
        )
    rows = list(
        (
            await db.execute(
                query.order_by(WorkflowRunTable.created_at.desc(), WorkflowRunTable.id.desc()).limit(size + 1)
            )
        ).scalars()
    )
    more = len(rows) > size
    rows = rows[:size]
    return WorkflowRunPage(
        items=[run_out(r) for r in rows],
        nextCursor=_encode_cursor(rows[-1]) if more and rows else None,
    )


async def _events_after(db: AsyncSession, run_id: str, after_seq: int, limit: int) -> list[WorkflowRunEventTable]:
    return list(
        (
            await db.execute(
                select(WorkflowRunEventTable)
                .where(WorkflowRunEventTable.run_id == run_id, WorkflowRunEventTable.seq > after_seq)
                .order_by(WorkflowRunEventTable.seq)
                .limit(limit)
            )
        ).scalars()
    )


async def get_run_detail(db: AsyncSession, run: WorkflowRunTable, after_seq: int = 0) -> WorkflowRunDetail:
    """The run, its inputs and its events after ``after_seq`` (one bounded page)."""
    events = await _events_after(db, run.id, after_seq, DETAIL_EVENT_PAGE + 1)
    return WorkflowRunDetail(
        run=run_out(run),
        inputs=run.inputs or {},
        events=[WorkflowRunEventOut.model_validate(e) for e in events[:DETAIL_EVENT_PAGE]],
        hasMoreEvents=len(events) > DETAIL_EVENT_PAGE,
    )


# ---------------------------------------------------------------------------
# Status writes (compare-and-set)
# ---------------------------------------------------------------------------
async def _set_status(
    run_id: str,
    *,
    expected: tuple[str, ...],
    new_status: str,
    error: str | None = None,
) -> WorkflowRunTable | None:
    """Move a run to ``new_status`` only if it is in ``expected``; returns the
    updated row, or ``None`` when someone else already moved it."""
    now = _now()
    values: dict[str, Any] = {"status": new_status, "updated_at": now}
    if new_status in TERMINAL_STATUSES:
        values["finished_at"] = now
        values["error"] = error
    async with SessionLocal() as db:
        result = await db.execute(
            update(WorkflowRunTable)
            .where(WorkflowRunTable.id == run_id, WorkflowRunTable.status.in_(expected))
            .values(**values)
        )
        if not result.rowcount:
            await db.rollback()
            return None
        await db.commit()
        return await db.get(WorkflowRunTable, run_id, populate_existing=True)


async def _announce(run: WorkflowRunTable) -> None:
    """Tell live viewers about a status change; expire the stream when the leg
    has closed. Best effort: the database is the record, Redis only fan-out."""
    try:
        await workflow_event_log.append(run.id, _status_frame(run))
        if run.status in TAIL_END_STATUSES:
            await workflow_event_log.mark_terminal(run.id)
    except Exception:
        logger.warning("workflow_run_publish_failed", "Could not publish a workflow run status",
                       run_id=run.id, exc_info=True)


async def _transition(
    run_id: str, *, expected: tuple[str, ...], new_status: str, error: str | None = None
) -> WorkflowRunTable | None:
    run = await _set_status(run_id, expected=expected, new_status=new_status, error=error)
    if run is not None:
        await _announce(run)
        logger.info("workflow_run_status", "Workflow run changed status",
                    run_id=run_id, status=new_status, workflow_id=run.workflow_id)
    return run


# ---------------------------------------------------------------------------
# Event shaping
# ---------------------------------------------------------------------------
def _short_id(value: Any) -> str | None:
    if isinstance(value, (str, int)) and not isinstance(value, bool):
        text = str(value)
        return text[:_MAX_ID_CHARS] if text else None
    return None


def _bounded_payload(event: dict[str, Any]) -> dict[str, Any]:
    """The event as stored: itself, or — past ``WORKFLOW_RUN_MAX_EVENT_BYTES`` —
    a marker that keeps what the timeline needs (type, name, workflow block)
    plus a preview of the serialised original."""
    limit = settings.workflows.max_event_bytes
    encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) <= limit:
        return event
    marker: dict[str, Any] = {
        "type": event.get("type"),
        "truncated": True,
        "originalBytes": len(encoded),
        "preview": encoded[: limit // 2].decode("utf-8", errors="ignore"),
    }
    if isinstance(event.get("name"), str):
        marker["name"] = event["name"][:_MAX_ID_CHARS]
    workflow = event.get("workflow")
    if isinstance(workflow, dict):
        marker["workflow"] = {k: _short_id(v) for k, v in workflow.items() if isinstance(k, str)}
    return marker


def _event_row(run_id: str, seq: int, event: dict[str, Any]) -> dict[str, Any]:
    workflow = event.get("workflow") if isinstance(event.get("workflow"), dict) else {}
    return {
        "run_id": run_id,
        "seq": seq,
        "type": str(event.get("type"))[:64],
        "node_id": _short_id(workflow.get("nodeId")),
        "execution_id": _short_id(workflow.get("executionId")),
        "parent_execution_id": _short_id(workflow.get("parentExecutionId")),
        "payload": _bounded_payload(event),
        "created_at": _now(),
    }


def _wire_event(row: dict[str, Any]) -> dict[str, Any]:
    """A persisted row as the event stream sends it (the run detail's shape)."""
    return WorkflowRunEventOut.model_validate(row).model_dump(mode="json")


def _is_interrupt(event: dict[str, Any]) -> bool:
    return event.get("type") == "CUSTOM" and event.get("name") == HITL_INTERRUPT


# ---------------------------------------------------------------------------
# Starting, resuming, cancelling, deleting
# ---------------------------------------------------------------------------
async def _count_active(db: AsyncSession, user_id: str) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(WorkflowRunTable)
            .where(WorkflowRunTable.user_id == user_id, WorkflowRunTable.status.in_(ACTIVE_STATUSES))
        )
    ).scalar_one()


async def _check_active_cap(db: AsyncSession, user_id: str) -> None:
    if await _count_active(db, user_id) >= settings.workflows.max_active_runs_per_user:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many workflow runs in progress. Wait for one to finish.",
        )


_LIVE_RUN_DETAIL = "This workflow already has a run in progress."


async def start_workflow_run(
    db: AsyncSession,
    user_id: str,
    workflow_id: str,
    inputs: dict[str, Any],
    *,
    trigger_kind: WorkflowTriggerKind = "manual",
    workflow: WorkflowOut | None = None,
) -> WorkflowRunTable:
    """Create a ``queued`` run of one of the user's workflows; the caller launches it.

    The upstream read comes first — before this session touches the database —
    so no connection is held while waiting on the agents service. It proves the
    workflow is the user's (404 otherwise) and pins the version the run will
    execute, so the stored ``version_no`` is exactly what ran. A caller that
    has just read the workflow itself (the scheduler) passes it as
    ``workflow`` instead of reading it twice.

    ``trigger_kind`` is ``manual`` ("Run now") or ``schedule`` (a scheduler
    fire, whose ``inputs`` are the trigger node's static ones); the engine is
    told, and its trigger node reports it.
    """
    if workflow is None:
        workflow = await get_workflow(user_id, workflow_id)

    await _check_active_cap(db, user_id)
    live = (
        await db.execute(
            select(WorkflowRunTable.id).where(
                WorkflowRunTable.user_id == user_id,
                WorkflowRunTable.workflow_id == workflow_id,
                WorkflowRunTable.status.in_(LIVE_STATUSES),
            )
        )
    ).first()
    if live is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_LIVE_RUN_DETAIL)

    now = _now()
    run = WorkflowRunTable(
        id=str(uuid4()),
        user_id=user_id,
        workflow_id=workflow_id,
        workflow_name=workflow.name,
        version_no=workflow.latestVersionNo,
        trigger_kind=trigger_kind,
        status="queued",
        inputs=inputs,
        thread_id=str(uuid4()),
        event_count=0,
        started_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(run)
    try:
        await db.commit()
    except IntegrityError as exc:
        # A racing start won the unique partial index.
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_LIVE_RUN_DETAIL) from exc
    await db.refresh(run)

    try:
        await _prune_old_runs(db, user_id, workflow_id)
    except SQLAlchemyError:
        # Housekeeping only: the next start prunes again.
        await db.rollback()
        logger.warning("workflow_run_prune_failed", "Could not prune old workflow runs",
                       workflow_id=workflow_id, exc_info=True)
    logger.info("workflow_run_created", "Workflow run created", run_id=run.id, workflow_id=workflow_id,
                version_no=run.version_no, trigger_kind=trigger_kind)
    return run


async def _delete_runs(db: AsyncSession, run_ids: list[str]) -> int:
    """Delete runs and their events — events first, explicitly, rather than
    relying on the database enforcing ``ON DELETE CASCADE``."""
    if not run_ids:
        return 0
    await db.execute(delete(WorkflowRunEventTable).where(WorkflowRunEventTable.run_id.in_(run_ids)))
    result = await db.execute(delete(WorkflowRunTable).where(WorkflowRunTable.id.in_(run_ids)))
    return result.rowcount or 0


async def _prune_old_runs(db: AsyncSession, user_id: str, workflow_id: str) -> None:
    """Keep the newest ``WORKFLOW_MAX_RUNS_PER_WORKFLOW`` runs (the live one
    counts); a live run is never pruned."""
    beyond = (
        await db.execute(
            select(WorkflowRunTable.id, WorkflowRunTable.status)
            .where(WorkflowRunTable.user_id == user_id, WorkflowRunTable.workflow_id == workflow_id)
            .order_by(WorkflowRunTable.created_at.desc(), WorkflowRunTable.id.desc())
            .offset(settings.workflows.max_runs_per_workflow)
        )
    ).all()
    old = [run_id for run_id, run_status in beyond if run_status not in LIVE_STATUSES]
    if old:
        await _delete_runs(db, old)
        await db.commit()


async def resume_workflow_run(
    db: AsyncSession, run: WorkflowRunTable, decision: str, comment: str | None
) -> WorkflowRunTable:
    """Answer the approval a ``waiting`` run is paused on; the caller launches the leg.

    Compare-and-set ``waiting`` → ``running``: a second answer (or an answer
    racing the TTL expiry or a cancel) finds the run no longer waiting → 409.
    """
    await _check_active_cap(db, run.user_id)
    result = await db.execute(
        update(WorkflowRunTable)
        .where(WorkflowRunTable.id == run.id, WorkflowRunTable.status == "waiting")
        .values(status="running", updated_at=_now())
    )
    if not result.rowcount:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This run is not waiting for an approval.")
    await db.commit()
    await db.refresh(run)
    logger.info("workflow_run_resumed", "Workflow run resumed", run_id=run.id, decision=decision,
                has_comment=comment is not None)
    return run


async def cancel_workflow_run(run: WorkflowRunTable) -> WorkflowRunTable:
    """Cancel a live run. The status is written first (compare-and-set), so a
    leg on any replica stops at its next write; a leg on this process is also
    woken at once. A run already finished is returned as it is."""
    updated = await _transition(run.id, expected=LIVE_STATUSES, new_status="cancelled",
                                error="Cancelled by the user.")
    workflow_run_manager.request_cancel(run.id)
    return updated or run


async def delete_runs_for_workflow(db: AsyncSession, user_id: str, workflow_id: str) -> int:
    """A deleted workflow's history goes with it: cancel what is live, delete the rest."""
    ids = list(
        (
            await db.execute(
                select(WorkflowRunTable.id).where(
                    WorkflowRunTable.user_id == user_id, WorkflowRunTable.workflow_id == workflow_id
                )
            )
        ).scalars()
    )
    for run_id in ids:
        workflow_run_manager.request_cancel(run_id)
    removed = await _delete_runs(db, ids)
    await db.commit()
    return removed


# ---------------------------------------------------------------------------
# The background leg
# ---------------------------------------------------------------------------
class _Superseded(Exception):
    """The row stopped being ``running`` under the leg (cancel, watchdog)."""


_EOF = object()
_CANCEL = object()


@dataclass
class _UpstreamFailure:
    """The reader's error, handed to the writer through the queue."""
    exc: BaseException


@dataclass
class _Leg:
    """What one streaming leg has seen so far."""
    run_id: str
    next_seq: int
    persisted: int
    buffer: list[dict[str, Any]] = field(default_factory=list)
    interrupted: bool = False
    finished: bool = False
    error: str | None = None
    truncated: bool = False


class WorkflowRunManager:
    """The in-process owner of each streaming leg: one task per run at a time."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._queues: dict[str, asyncio.Queue[Any]] = {}

    def launch(self, run_id: str, resume: dict[str, Any] | None = None) -> None:
        if self.has_live_task(run_id):
            return
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=_QUEUE_SIZE)
        self._queues[run_id] = queue
        task = asyncio.create_task(self._run(run_id, resume, queue))
        self._tasks[run_id] = task

        def _forget(done: asyncio.Task[None]) -> None:
            if self._tasks.get(run_id) is done:
                self._tasks.pop(run_id, None)
                self._queues.pop(run_id, None)

        task.add_done_callback(_forget)

    def has_live_task(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return bool(task and not task.done())

    def request_cancel(self, run_id: str) -> bool:
        """Wake this process's leg of the run, if it has one, to stop now."""
        queue = self._queues.get(run_id)
        if queue is None or not self.has_live_task(run_id):
            return False
        # A full queue means the writer is behind; it still stops at its next
        # persist, which finds the row no longer running.
        with contextlib.suppress(asyncio.QueueFull):
            queue.put_nowait(_CANCEL)
        return True

    async def _run(self, run_id: str, resume: dict[str, Any] | None, queue: asyncio.Queue[Any]) -> None:
        reader: asyncio.Task[None] | None = None
        try:
            async with SessionLocal() as db:
                run = await db.get(WorkflowRunTable, run_id)
                if run is None:
                    return
                if resume is None:
                    claimed = await db.execute(
                        update(WorkflowRunTable)
                        .where(WorkflowRunTable.id == run_id, WorkflowRunTable.status == "queued")
                        .values(status="running", updated_at=_now())
                    )
                    if not claimed.rowcount:
                        return
                    await db.commit()
                    await db.refresh(run)
                elif run.status != "running":
                    return
                leg = _Leg(run_id=run_id, next_seq=run.event_count + 1, persisted=run.event_count)
                body = {
                    "run_id": run.id,
                    "thread_id": run.thread_id,
                    "owner_user_id": run.user_id,
                    "workflow_id": run.workflow_id,
                    "version_no": run.version_no,
                    "inputs": run.inputs or {},
                    "resume": resume,
                    # How and when the run was started; the trigger node reports
                    # both (a resume re-runs no trigger, so they are inert there).
                    "trigger_kind": run.trigger_kind,
                    "fired_at": run.created_at.isoformat(),
                }
                user_id = run.user_id
                decision_workflow = await self._interrupt_block(db, run_id) if resume else None

            if resume is not None:
                # A fresh stream for the new leg (the paused one was set to expire).
                try:
                    await workflow_event_log.discard(run_id)
                except Exception:
                    logger.warning("workflow_run_stream_reset_failed", "Could not reset a run's live stream",
                                   run_id=run_id, exc_info=True)
            await _announce(run)
            if resume is not None:
                self._buffer(leg, {
                    "type": "CUSTOM",
                    "name": DECISION_MARKER,
                    "value": {k: v for k, v in resume.items() if v is not None},
                    "timestamp": int(time.time() * 1000),
                    **({"workflow": decision_workflow} if decision_workflow else {}),
                })

            reader = asyncio.create_task(_read_stream(body, user_id, queue))
            outcome = await self._consume(leg, queue)
            if outcome == "cancelled":
                return
            await self._flush(leg)
            if leg.error is not None:
                await _transition(run_id, expected=("running",), new_status="failed", error=leg.error)
            elif leg.interrupted:
                await _transition(run_id, expected=("running",), new_status="waiting")
            elif leg.finished:
                await _transition(run_id, expected=("running",), new_status="succeeded")
            else:
                await _transition(run_id, expected=("running",), new_status="failed",
                                  error="The workflow stream ended unexpectedly.")
        except _Superseded:
            logger.info("workflow_run_superseded", "Workflow run leg stopped: the run is no longer running",
                        run_id=run_id)
        except asyncio.CancelledError:
            await _transition(run_id, expected=ACTIVE_STATUSES, new_status="failed",
                              error="The run was interrupted.")
        except Exception:
            logger.error("workflow_run_failed", "Workflow run leg failed", run_id=run_id, exc_info=True)
            try:
                await _transition(run_id, expected=ACTIVE_STATUSES, new_status="failed",
                                  error="The workflow run failed unexpectedly.")
            except Exception:
                logger.error("workflow_run_fail_mark_failed", "Could not mark a workflow run failed",
                             run_id=run_id, exc_info=True)
        finally:
            if reader is not None and not reader.done():
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)

    @staticmethod
    async def _interrupt_block(db: AsyncSession, run_id: str) -> dict[str, Any] | None:
        """The ``workflow`` block of the approval being answered, so the
        decision marker lands on the same node in the timeline."""
        recent = (
            await db.execute(
                select(WorkflowRunEventTable.payload)
                .where(WorkflowRunEventTable.run_id == run_id, WorkflowRunEventTable.type == "CUSTOM")
                .order_by(WorkflowRunEventTable.seq.desc())
                .limit(20)
            )
        ).scalars()
        for payload in recent:
            if isinstance(payload, dict) and payload.get("name") == HITL_INTERRUPT:
                block = payload.get("workflow")
                return block if isinstance(block, dict) else None
        return None

    async def _consume(self, leg: _Leg, queue: asyncio.Queue[Any]) -> str:
        """Drain the reader's queue into persisted batches until the leg ends.

        Returns ``"ended"`` (stream over, RUN_ERROR seen or upstream failure
        recorded on ``leg``) or ``"cancelled"``.
        """
        cfg = settings.workflows
        loop = asyncio.get_running_loop()
        deadline = loop.time() + cfg.stream_max_seconds
        flush_at: float | None = None
        while True:
            now = loop.time()
            if now >= deadline:
                leg.error = "The workflow ran past its time limit."
                return "ended"
            if leg.buffer and flush_at is not None and now >= flush_at:
                await self._flush(leg)
                flush_at = None
            wait = deadline - now if flush_at is None else max(0.0, min(flush_at, deadline) - now)
            try:
                item = await asyncio.wait_for(queue.get(), timeout=wait)
            except TimeoutError:
                continue
            if item is _CANCEL:
                # The cancel wrote the status already; buffered events go unsaved.
                return "cancelled"
            if item is _EOF:
                return "ended"
            if isinstance(item, _UpstreamFailure):
                leg.error = _upstream_failure_message(item.exc)
                return "ended"
            self._buffer(leg, item)
            if item.get("type") == "RUN_ERROR":
                message = item.get("message")
                leg.error = (str(message)[:1000] if message else None) or "The workflow failed."
                return "ended"
            if len(leg.buffer) >= cfg.persist_batch_size:
                await self._flush(leg)
                flush_at = None
            elif flush_at is None:
                flush_at = loop.time() + cfg.persist_interval_ms / 1000

    def _buffer(self, leg: _Leg, event: dict[str, Any]) -> None:
        """Fold one event into the leg's state and queue it for persistence,
        honouring the per-run event cap."""
        event_type = event.get("type")
        if event_type == "RUN_FINISHED":
            leg.finished = True
        elif _is_interrupt(event):
            leg.interrupted = True
        cap = settings.workflows.max_events_per_run
        if leg.persisted + len(leg.buffer) >= cap and event_type not in _KEPT_PAST_CAP and not _is_interrupt(event):
            if not leg.truncated:
                leg.truncated = True
                marker = {"type": "CUSTOM", "name": TRUNCATION_MARKER,
                          "value": {"maxEvents": cap}, "timestamp": int(time.time() * 1000)}
                leg.buffer.append(_event_row(leg.run_id, leg.next_seq, marker))
                leg.next_seq += 1
            return
        leg.buffer.append(_event_row(leg.run_id, leg.next_seq, event))
        leg.next_seq += 1

    async def _flush(self, leg: _Leg) -> None:
        """Persist the buffer in one transaction — only while the row is still
        ``running`` — then publish it to live viewers."""
        if not leg.buffer:
            return
        rows, leg.buffer = leg.buffer, []
        async with SessionLocal() as db:
            still_running = await db.execute(
                update(WorkflowRunTable)
                .where(WorkflowRunTable.id == leg.run_id, WorkflowRunTable.status == "running")
                .values(event_count=leg.persisted + len(rows), updated_at=_now())
            )
            if not still_running.rowcount:
                await db.rollback()
                raise _Superseded()
            await db.execute(insert(WorkflowRunEventTable), rows)
            await db.commit()
        leg.persisted += len(rows)
        try:
            await workflow_event_log.append(leg.run_id, {"type": "events", "events": [_wire_event(r) for r in rows]})
        except Exception:
            # Viewers catch up from the database on their next connect.
            logger.warning("workflow_run_publish_failed", "Could not publish workflow run events",
                           run_id=leg.run_id, exc_info=True)


def _upstream_failure_message(exc: BaseException) -> str:
    """A user-facing reason; never the upstream body or a stack trace."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"The workflow engine refused the run (HTTP {exc.response.status_code})."
    if isinstance(exc, httpx.RequestError):
        return "The workflow engine could not be reached."
    return "The workflow stream failed."


async def _read_stream(body: dict[str, Any], user_id: str, queue: asyncio.Queue[Any]) -> None:
    """The reader half of a leg: SSE from the agents service → the queue.

    Ends with ``_EOF``, or with an ``_UpstreamFailure`` carrying the error; the
    writer decides what either means for the run.
    """
    url = f"{workflows_base_url()}/runs/stream"
    headers = internal_service_headers(None, user_id=user_id)
    headers["Accept"] = "text/event-stream"
    http = settings.http
    # The read timeout is the watchdog's idle timeout, not the chat's: a node
    # may legitimately go quiet for a while (a long model call), and the two
    # should agree on when "quiet" becomes "dead".
    timeout = httpx.Timeout(
        connect=http.inference_connect_seconds,
        read=float(settings.workflows.stream_idle_timeout_seconds),
        write=http.inference_write_seconds,
        pool=http.inference_pool_seconds,
    )
    try:
        async with httpx.AsyncClient(
            timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client, client.stream("POST", url, json=body, headers=headers) as response:
            response.raise_for_status()
            buffer = ""
            async for chunk in response.aiter_bytes():
                buffer, events = _parse_sse_bytes(buffer, chunk)
                for event in events:
                    await queue.put(event)
        await queue.put(_EOF)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("workflow_run_upstream_failed", "Workflow run stream from the agents service failed",
                       run_id=body.get("run_id"), error_type=type(exc).__name__)
        await queue.put(_UpstreamFailure(exc))


workflow_run_manager = WorkflowRunManager()


async def launch_or_fail(run_id: str, resume: dict[str, Any] | None = None) -> None:
    """Launch a leg; if even that fails, the run must not sit live forever."""
    try:
        workflow_run_manager.launch(run_id, resume)
    except Exception:
        logger.error("workflow_run_launch_failed", "Could not launch a workflow run", run_id=run_id, exc_info=True)
        await _transition(run_id, expected=ACTIVE_STATUSES, new_status="failed",
                          error="The run could not be started.")
        raise


# ---------------------------------------------------------------------------
# The event stream (history + live)
# ---------------------------------------------------------------------------
def _sse(frame: dict[str, Any], event_id: int | None = None) -> bytes:
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}data: {json.dumps(frame, ensure_ascii=False, separators=(',', ':'))}\n\n".encode()


async def _current_run(run_id: str) -> WorkflowRunTable | None:
    async with SessionLocal() as db:
        return await db.get(WorkflowRunTable, run_id)


async def _replay(run_id: str, after_seq: int) -> AsyncIterator[tuple[int, bytes]]:
    """Persisted events after ``after_seq``, a short session per page."""
    while True:
        async with SessionLocal() as db:
            page = await _events_after(db, run_id, after_seq, _REPLAY_PAGE)
            frames = [(e.seq, WorkflowRunEventOut.model_validate(e).model_dump(mode="json")) for e in page]
        for seq, wire in frames:
            yield seq, _sse({"type": "event", "event": wire}, seq)
            after_seq = seq
        if len(frames) < _REPLAY_PAGE:
            return


async def stream_run_events(run_id: str, after_seq: int) -> AsyncIterator[bytes]:
    """SSE for one run: the run's status, its events after ``after_seq`` from the
    database, then — while a leg is streaming — the live tail from Redis, until
    the run ends or pauses. Each event frame carries ``id: <seq>``, so a
    reconnecting ``EventSource`` resumes exactly where it left off.

    Gap-free by construction: the Redis position is taken *before* the database
    is read, and a leg persists every event before publishing it, so an event
    is either in the replay or after the anchor (duplicates are dropped by seq).
    The router has checked ownership.
    """
    try:
        anchor = await workflow_event_log.last_entry_id(run_id)
    except Exception:
        anchor = None
        logger.warning("workflow_run_tail_unavailable", "Live tail unavailable; replaying history only",
                       run_id=run_id, exc_info=True)
        redis_ok = False
    else:
        redis_ok = True

    run = await _current_run(run_id)
    if run is None:
        return
    first_status = run.status
    yield _sse(_status_frame(run))
    last_seq = after_seq
    async for seq, frame in _replay(run_id, last_seq):
        last_seq = seq
        yield frame

    run = await _current_run(run_id)
    if run is None:
        return
    tailed = run.status in ACTIVE_STATUSES and redis_ok
    if tailed:
        async for seq, frame in _tail(run_id, anchor, last_seq):
            if seq is not None:
                last_seq = seq
            yield frame
        # Catch up on anything the tail missed (Redis trimmed or unreachable).
        async for seq, frame in _replay(run_id, last_seq):
            last_seq = seq
            yield frame
        run = await _current_run(run_id)
        if run is None:
            return
    if tailed or run.status != first_status:
        yield _sse(_status_frame(run))


async def _tail(run_id: str, anchor: str | None, last_seq: int) -> AsyncIterator[tuple[int | None, bytes]]:
    """The live part: Redis frames after ``anchor``, deduplicated by seq, with
    a keep-alive comment while idle. Ends when a status frame closes the leg,
    or when the database says the run is no longer streaming."""
    async def leg_closed() -> bool:
        run = await _current_run(run_id)
        return run is None or run.status not in ACTIVE_STATUSES

    frames: asyncio.Queue[Any] = asyncio.Queue()

    async def pump() -> None:
        try:
            async for _entry_id, frame in workflow_event_log.read_since(
                run_id, anchor or "0", terminal_statuses=set(TAIL_END_STATUSES), on_idle=leg_closed
            ):
                await frames.put(frame)
        except Exception:
            logger.warning("workflow_run_tail_failed", "Live tail of a workflow run failed",
                           run_id=run_id, exc_info=True)
        finally:
            await frames.put(_EOF)

    task = asyncio.create_task(pump())
    try:
        heartbeat = settings.workflows.stream_heartbeat_seconds
        while True:
            try:
                frame = await asyncio.wait_for(frames.get(), timeout=heartbeat)
            except TimeoutError:
                yield None, b": keep-alive\n\n"
                continue
            if frame is _EOF or not isinstance(frame, dict):
                return
            if frame.get("type") == "events":
                for event in frame.get("events") or []:
                    seq = event.get("seq") if isinstance(event, dict) else None
                    if isinstance(seq, int) and seq > last_seq:
                        last_seq = seq
                        yield seq, _sse({"type": "event", "event": event}, seq)
            elif frame.get("type") == "status":
                run = frame.get("run") or {}
                if run.get("status") in TAIL_END_STATUSES:
                    # The closing status comes from the database after catch-up.
                    return
                yield None, _sse(frame)
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


# ---------------------------------------------------------------------------
# Watchdog and startup
# ---------------------------------------------------------------------------
async def reap_workflow_runs() -> int:
    """Fail stalled legs and expired approvals. Returns how many runs it ended."""
    cfg = settings.workflows
    now = _now()
    stalled_before = now - timedelta(seconds=cfg.stream_idle_timeout_seconds)
    expired_before = now - timedelta(hours=cfg.approval_ttl_hours)
    async with SessionLocal() as db:
        stalled = list(
            (
                await db.execute(
                    select(WorkflowRunTable.id).where(
                        WorkflowRunTable.status.in_(ACTIVE_STATUSES), WorkflowRunTable.updated_at < stalled_before
                    )
                )
            ).scalars()
        )
        expired = list(
            (
                await db.execute(
                    select(WorkflowRunTable.id).where(
                        WorkflowRunTable.status == "waiting", WorkflowRunTable.updated_at < expired_before
                    )
                )
            ).scalars()
        )
    ended = 0
    for run_id in stalled:
        if await _transition(run_id, expected=ACTIVE_STATUSES, new_status="failed",
                             error="The workflow stopped responding."):
            workflow_run_manager.request_cancel(run_id)
            ended += 1
    for run_id in expired:
        if await _transition(run_id, expected=("waiting",), new_status="failed",
                             error="The approval expired before anyone answered it."):
            ended += 1
    return ended


async def run_workflow_watchdog(stop_event: asyncio.Event) -> None:
    """Background loop (FastAPI lifespan): :func:`reap_workflow_runs` every
    ``WORKFLOW_RUN_WATCHDOG_INTERVAL_SECONDS`` until ``stop_event`` is set."""
    interval = settings.workflows.watchdog_interval_seconds
    while not stop_event.is_set():
        try:
            reaped = await reap_workflow_runs()
            if reaped:
                logger.info("workflow_runs_reaped", "Workflow watchdog ended runs", count=reaped)
        except Exception:
            # A dead watchdog leaves stuck runs holding their slots: log, keep going.
            logger.error("workflow_watchdog_failed", "Workflow watchdog pass failed", exc_info=True)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop_event.wait(), timeout=interval)


async def cleanup_orphaned_workflow_runs() -> None:
    """On startup, fail every run whose leg was streaming when the process died.

    ``waiting`` runs are left alone: the agents stream had already ended and
    the engine's checkpoint holds the state, so they resume after a restart.
    """
    now = _now()
    async with SessionLocal() as db:
        await db.execute(
            update(WorkflowRunTable)
            .where(WorkflowRunTable.status.in_(ACTIVE_STATUSES))
            .values(status="failed", error="The run was interrupted by a service restart.",
                    finished_at=now, updated_at=now)
        )
        await db.commit()


__all__ = [
    "LIVE_STATUSES",
    "TERMINAL_STATUSES",
    "cancel_workflow_run",
    "cleanup_orphaned_workflow_runs",
    "delete_runs_for_workflow",
    "get_run_detail",
    "get_run_for_user",
    "launch_or_fail",
    "list_runs",
    "reap_workflow_runs",
    "resume_workflow_run",
    "run_out",
    "run_workflow_watchdog",
    "start_workflow_run",
    "stream_run_events",
    "workflow_event_log",
    "workflow_run_manager",
]
