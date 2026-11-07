"""The TaskRunner: runs background tasks, settles them, and wakes their parents (plan 41 §3.4 to §3.8).

One ``asyncio`` task per active run, in this process. A run rebuilds its node
of the agent's sub-agent tree through the very same ``build_deep_agent`` path
a top-level run uses — the definition pinned when the root run started, the
task's own run context rebuilt from its row, its own MCP session, the shared
durable checkpointer on the thread ``task_id`` — and streams through the
AG-UI normalizer into Redis (``task:{task_id}:events``).

**Lifecycle of a task** (statuses of §14.1)::

    pending ─► running ─► success | error | cancelled         (settled)
                 │  ▲
                 │  └── update / resume / wake ── waiting, waiting_children
                 ├─► waiting           (its run paused on an approval)
                 └─► waiting_children  (its run ended; a child has not settled)

**Settle (§3.5).** A task settles when its latest run has ended, nothing is
queued, it is not waiting for an approval, and every child has settled. Its
parent is then told:

* a task parent with an active run learns it by itself (deepagents' pull
  before each model call); one that is idle is woken with a new run whose
  input is the child's notification (``notification.py``); one that is
  waiting for an approval is woken after it resumes;
* the orchestrator (depth 1) gets an outbox row (``parent_notified_at`` NULL)
  and a ``tasks:outbox`` doorbell; the bridge wakes it.

``parent_notified_at`` also records a delivery by pull: the router marks it
when the parent reads the settled task (``utils.async_tasks``).

**Concurrency.** Every transition of a task happens under that task's lock;
two locks are never held at once (a child's settle reaches its parent only
after the child's lock is released), so there is no lock-order deadlock.
One process holds a task's runs — the middleware's client is in process —
so this assumes one agents replica, as on Dennis today.
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.types import Command

from core.logging import clear_context, get_logger, set_context
from core.settings import settings
from harness.abstractions.agent_spec import MAX_SUBAGENT_DEPTH
from harness.abstractions.deep_agent import DeepAgent
from harness.agui.events import TOKEN_USAGE_EVENT_TYPE
from harness.async_tasks import metrics
from harness.async_tasks.events import TaskStreamPublisher
from harness.async_tasks.notification import (
    build_notification,
    final_content,
    notification_payload,
    text_preview,
    to_human_message,
)
from harness.async_tasks.specs import (
    TaskNode,
    UnknownTaskNode,
    decode_path,
    display_path,
    encode_path,
    graph_id_for,
)
from harness.async_tasks.store import (
    ACTIVE_STATUSES,
    RUN_FINAL_STATUSES,
    SETTLED_STATUSES,
    AsyncTaskStore,
    now,
)
from harness.async_tasks.token import InheritedContext, LaunchClaims
from schema import AgentResumeRequest
from schema.inference import ResumeItem
from utils.agents import definition_candidates
from utils.checkpointer import release_checkpoint_unless_paused
from utils.hitl_resume import build_resume_command
from utils.mcp_tools import optional_mcp_session

logger = get_logger(__name__)

#: The error text a run reports for each way it can fail. Short and free of
#: internals: deepagents shows it to the parent's model.
RUN_FAILED = "The subagent failed."
RUN_TIMED_OUT = "The subagent ran too long and was stopped."
RUN_RESTARTED = "interrupted by restart"
BUILD_FAILED = "The subagent could not be started."

#: A task's status as its latest run ended.
_SETTLED_FROM_RUN = {"success": "success", "error": "error", "timeout": "error", "interrupted": "cancelled"}

#: The outcomes a parent's ``async_tasks`` state records for a finished child.
_TRACKED_SETTLED = frozenset({"success", "error", "cancelled"})

#: The description kept on a task's row (TaskOut.description), at most.
_DESCRIPTION_CHARS = 2000


class TaskRefused(Exception):
    """A request the runner will not carry out; becomes an HTTP error.

    The middleware turns any failed call into a tool result the model reads
    ("Failed to launch async subagent ..."), so a refused start or update is a
    tool error, never a hang.
    """

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class DefinitionUnavailable(Exception):
    """The agent definition a task tree is pinned to can no longer be built."""


@dataclass
class RunOutcome:
    """How one run ended, as the run itself saw it."""
    status: str
    error: str | None = None
    waiting: bool = False
    usage: dict[str, int] = field(default_factory=dict)
    # The run's final message (a successful run that did not pause), kept on
    # the task as its result.
    result: dict[str, Any] | None = None
    # The children whose outcome the run's own state records (its middleware
    # took the result in); ``None`` when the run did not end cleanly.
    seen_settled: frozenset[str] | None = None


@dataclass
class _Pending:
    """A run waiting to start (queued behind the active one)."""
    run_id: str
    kind: str
    inputs: list[dict[str, Any]]
    command: Command | None = None


@dataclass
class _Active:
    """The run a task is executing (or about to)."""
    run_id: str
    kind: str
    inputs: list[dict[str, Any]]
    command: Command | None = None
    started: bool = False
    cancel_requested: bool = False
    job: asyncio.Task[Any] | None = None
    began: float = field(default_factory=time.monotonic)


class _Usage:
    """Sums the run's ``TOKEN_USAGE`` events into ``TaskOut.usage`` keys.

    A summary call of the task's own automatic compaction counts too: it is
    the sub-agent's spend, exactly as it was booked for a blocking sub-agent.
    """

    def __init__(self) -> None:
        self.totals: dict[str, int] = {}
        # The model the calls actually went to, as the usage event reports it.
        # It names the task's model for its record and its cost: the built
        # model object does not reliably expose a plain name.
        self.model: str | None = None

    def _add(self, key: str, value: Any) -> None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            self.totals[key] = self.totals.get(key, 0) + int(value)

    def observe(self, event: Mapping[str, Any]) -> None:
        if event.get("type") != "CUSTOM" or event.get("name") != TOKEN_USAGE_EVENT_TYPE:
            return
        value = event.get("value")
        if not isinstance(value, Mapping):
            return
        self._add("input_tokens", value.get("input_tokens"))
        self._add("output_tokens", value.get("output_tokens"))
        details_in = value.get("input_token_details")
        if isinstance(details_in, Mapping):
            self._add("cached_input_tokens", details_in.get("cache_read"))
        details_out = value.get("output_token_details")
        if isinstance(details_out, Mapping):
            self._add("reasoning_tokens", details_out.get("reasoning"))
        self._add("model_latency_ms", value.get("latency_ms"))
        self._add("calls", 1)
        model = value.get("model")
        if self.model is None and isinstance(model, str) and model:
            self.model = model


def parse_sse_frames(frame: bytes | str) -> list[dict[str, Any]]:
    """The AG-UI events in one SSE chunk from ``BaseAgent.astream`` (``data: {...}``)."""
    text = frame.decode("utf-8", errors="replace") if isinstance(frame, bytes) else frame
    events: list[dict[str, Any]] = []
    for block in text.split("\n\n"):
        data = "\n".join(line[5:].lstrip() for line in block.splitlines() if line.startswith("data:"))
        if not data:
            continue
        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def _jsonable(value: Any) -> Any:
    """``value`` as plain JSON data (interrupt values may be models)."""
    return json.loads(json.dumps(value, default=lambda o: o.model_dump() if hasattr(o, "model_dump") else str(o)))


def task_context(task: Mapping[str, Any], run_id: str) -> dict[str, Any]:
    """A task run's context, rebuilt from its row — never from a request.

    ``branch_thread_id`` is the root's branch: the shared scratch store and
    everything else keyed by branch see the orchestrator's branch, not the
    task's own thread. ``async_task_id`` marks the run as a task's (no
    ``ask_user``).
    """
    inherited = InheritedContext.model_validate(task.get("context") or {})
    context: dict[str, Any] = {
        "user_id": task["user_id"],
        "conversation_id": task["conversation_id"],
        "run_id": run_id,
        "thread_id": task["task_id"],
        "branch_thread_id": task["branch_thread_id"],
        "async_task_id": task["task_id"],
        "interactive": inherited.interactive,
        "search_past_convs": inherited.search_past_convs,
    }
    if inherited.use_memory is not None:
        context["use_memory"] = inherited.use_memory
    if inherited.tool_config is not None:
        context["tool_config"] = inherited.tool_config
    if inherited.agent_owner_id:
        context["agent_owner_id"] = inherited.agent_owner_id
    if inherited.command:
        context["command"] = inherited.command
    return context


McpSessionFactory = Callable[[], AbstractAsyncContextManager[Any]]


class TaskRunner:
    """Runs, settles and wakes background tasks (see module doc)."""

    def __init__(
        self,
        store: AsyncTaskStore,
        publisher: TaskStreamPublisher,
        *,
        mcp_session: McpSessionFactory = optional_mcp_session,
    ) -> None:
        self.store = store
        self.publisher = publisher
        self._mcp_session = mcp_session
        self._active: dict[str, _Active] = {}
        self._queue: dict[str, list[_Pending]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._jobs: set[asyncio.Task[Any]] = set()
        # Tasks a restart cut: recovery settles them but never wakes them.
        self._no_wake: set[str] = set()
        # Set at shutdown: no new run starts (a finishing run's follow-up
        # stays queued in the table, and startup recovery settles it).
        self._closed = False

    # -- bookkeeping -----------------------------------------------------------
    def _lock(self, task_id: str) -> asyncio.Lock:
        lock = self._locks.get(task_id)
        if lock is None:
            lock = self._locks[task_id] = asyncio.Lock()
        return lock

    def is_active(self, task_id: str) -> bool:
        """Whether the task has a run this process is executing."""
        return task_id in self._active

    async def idle(self) -> None:
        """Wait until no run is executing (tests, shutdown)."""
        while self._jobs:
            await asyncio.gather(*list(self._jobs), return_exceptions=True)

    async def shutdown(self) -> None:
        """Stop every run. Their rows stay active; startup recovery settles them."""
        self._closed = True
        for job in list(self._jobs):
            job.cancel()
        await asyncio.gather(*list(self._jobs), return_exceptions=True)
        await self.publisher.aclose()

    async def task_out(self, task: Mapping[str, Any]) -> dict[str, Any]:
        """A task row in the ``TaskOut`` wire shape (§14.1)."""
        usage = (await self.store.usage_totals([task["task_id"]])).get(task["task_id"], {})
        return task_out_from_row(task, usage)

    async def _publish(self, event: str, task_id: str) -> None:
        task = await self.store.get_task(task_id)
        if task is not None:
            await self.publisher.status(event, await self.task_out(task))

    async def _set_status(self, task: dict[str, Any], status: str, **fields: Any) -> None:
        if task["status"] == status and not fields:
            return
        await self.store.update_task(task["task_id"], {"status": status, **fields})
        task.update({"status": status, **fields})
        await self._publish("TASK_SETTLED" if status in SETTLED_STATUSES else "TASK_STATUS", task["task_id"])

    # -- creating tasks and runs ---------------------------------------------
    async def create_task(self, claims: LaunchClaims, subagent_name: str) -> dict[str, Any]:
        """A new task (``threads.create``), a child of the caller in ``claims``.

        Refused when the tree would be too deep, the caller is no longer
        running, or a cap is reached — all fail closed.
        """
        depth = claims.caller_depth + 1
        if depth > MAX_SUBAGENT_DEPTH:
            raise TaskRefused(400, f"Sub-agents may nest at most {MAX_SUBAGENT_DEPTH} levels.")
        if claims.caller_task_id is not None:
            caller = await self.store.get_task(claims.caller_task_id)
            if (
                caller is None
                or caller["user_id"] != claims.user_id
                or caller["conversation_id"] != claims.conversation_id
                or caller["status"] in SETTLED_STATUSES
            ):
                raise TaskRefused(409, "The calling task is not running.")
        caps = settings.async_tasks
        if await self.store.count_active_for_user(claims.user_id) >= caps.max_active_per_user:
            raise TaskRefused(429, "Too many background tasks are running; wait for one to finish.")
        siblings = await self.store.count_active_children(
            parent_task_id=claims.caller_task_id,
            conversation_id=claims.conversation_id,
            branch_thread_id=claims.branch_thread_id,
        )
        if siblings >= caps.max_children_per_task:
            raise TaskRefused(429, "Too many sub-agent tasks are open here; wait for one to finish.")
        task = {
            "task_id": str(uuid.uuid4()),
            "user_id": claims.user_id,
            "conversation_id": claims.conversation_id,
            "root_run_id": claims.root_run_id,
            "branch_thread_id": claims.branch_thread_id,
            "parent_task_id": claims.caller_task_id,
            "depth": depth,
            "agent_slug": claims.agent_slug,
            "definition_version": claims.definition_version,
            "subagent_path": encode_path([*claims.caller_path, subagent_name]),
            "interactive": claims.context.interactive,
            "context": claims.context.model_dump(mode="json"),
            "status": "pending",
            "name": subagent_name,
        }
        await self.store.insert_task(task)
        logger.info("async_task_created", "Background task created", task_id=task["task_id"], depth=depth,
                    agent_slug=claims.agent_slug)
        await self._publish("TASK_STARTED", task["task_id"])
        stored = await self.store.get_task(task["task_id"])
        if stored is None:
            raise TaskRefused(500, "The task could not be stored.")
        return stored

    async def create_run(
        self,
        task: Mapping[str, Any],
        *,
        assistant_id: str,
        messages: Sequence[Mapping[str, Any]],
        strategy: str,
    ) -> dict[str, Any]:
        """A new run of ``task`` (``runs.create``): its start, or a follow-up.

        * The first run starts the task.
        * While a run is active: ``interrupt`` (the default, D2) stops it and
          runs the follow-up next, on the same thread; ``enqueue`` queues it;
          ``reject`` refuses. **Pending guard:** a first run that has not
          started yet is not cancelled — the follow-up joins its input, so the
          original task text is never lost (§3.4).
        * A task waiting (for children or an approval) runs the follow-up now.
        * A settled task is **reopened**: running again, ``settled_at`` and
          ``parent_notified_at`` cleared, same thread (§3.4, §3.8).
        """
        task_id = task["task_id"]
        expected = graph_id_for(task["agent_slug"], task["definition_version"], decode_path(task["subagent_path"]))
        if assistant_id != expected:
            raise TaskRefused(400, "assistant_id does not name this task's sub-agent.")
        inputs = [{"role": "user", "content": m["content"]} for m in messages]
        async with self._lock(task_id):
            fresh = await self.store.get_task(task_id)
            if fresh is None:
                raise TaskRefused(404, "Not found.")
            active = self._active.get(task_id)
            if active is not None and not active.started and strategy != "reject":
                active.inputs.extend(inputs)
                run = await self.store.get_run(active.run_id)
                logger.info("async_task_update_folded", "Follow-up joined a run that had not started",
                            task_id=task_id, run_id=active.run_id)
                if run is None:
                    raise TaskRefused(500, "The run could not be read.")
                return run
            runs_so_far = await self.store.count_runs(task_id)
            if runs_so_far >= settings.async_tasks.max_runs_per_task:
                raise TaskRefused(429, "This task has had too many runs; start a new task instead.")
            if active is not None and strategy == "reject":
                raise TaskRefused(409, "The task is busy.")
            kind = "start" if runs_so_far == 0 else "update"
            if kind == "start" and not fresh.get("description"):
                description = "\n".join(_message_text(m) for m in inputs).strip()[:_DESCRIPTION_CHARS]
                await self.store.update_task(task_id, {"description": description or None})
            pending = _Pending(run_id=str(uuid.uuid4()), kind=kind, inputs=inputs)
            await self.store.insert_run({
                "run_id": pending.run_id, "task_id": task_id, "kind": kind,
                "multitask_strategy": strategy, "status": "pending",
            })
            if active is not None and strategy == "enqueue":
                self._queue.setdefault(task_id, []).append(pending)
            elif active is not None:
                # Interrupt: drop whatever was queued, stop the active run; the
                # follow-up starts as soon as that run has wound down.
                for dropped in self._queue.pop(task_id, []):
                    await self.store.update_run(dropped.run_id, {"status": "interrupted", "ended_at": now()})
                self._queue[task_id] = [pending]
                await self._stop_active(active)
            else:
                if fresh["status"] in SETTLED_STATUSES:
                    await self._reopen(fresh)
                await self._start(fresh, pending)
            run = await self.store.get_run(pending.run_id)
        if run is None:
            raise TaskRefused(500, "The run could not be read.")
        return run

    async def _reopen(self, task: dict[str, Any]) -> None:
        """A settled task runs again (§3.4): its settle and notification are cleared."""
        await self.store.update_task(task["task_id"], {
            "status": "running", "settled_at": None, "parent_notified_at": None,
            "result_preview": None, "error": None, "cancel_reason": None,
        })
        task.update(status="running", settled_at=None, parent_notified_at=None)
        await self.publisher.persist_events(task["task_id"])
        # Announced like any status change: the bridge clears the settle it
        # mirrored (and the "handled" mark a Stop left), so the card shows the
        # task running again and its next settle wakes the orchestrator.
        await self._publish("TASK_STATUS", task["task_id"])
        logger.info("async_task_reopened", "A settled background task was reopened", task_id=task["task_id"])

    async def _stop_active(self, active: _Active) -> None:
        """Mark the active run interrupted and cancel its job (no await: the job
        winds down on its own and needs this task's lock to finish)."""
        await self.store.update_run(active.run_id, {"status": "interrupted", "ended_at": now()})
        active.cancel_requested = True
        if active.job is not None:
            active.job.cancel()

    async def _start(self, task: dict[str, Any], pending: _Pending) -> None:
        """Launch a run's job (the caller holds the task's lock)."""
        task_id = task["task_id"]
        if self._closed:
            return
        active = _Active(run_id=pending.run_id, kind=pending.kind, inputs=list(pending.inputs), command=pending.command)
        self._active[task_id] = active
        # A fresh context: the run outlives the request that started it, and its
        # logs must carry the task, not that request's id.
        job = asyncio.create_task(
            self._run_job(task, active), name=f"async-task-{task_id}", context=contextvars.Context()
        )
        active.job = job
        self._jobs.add(job)
        job.add_done_callback(self._jobs.discard)
        metrics.record_active(len(self._active))
        if task["status"] != "running" and task["status"] != "pending":
            await self._set_status(task, "running")

    # -- executing a run ------------------------------------------------------
    async def _run_job(self, task: Mapping[str, Any], active: _Active) -> None:
        """One run, start to finish. Never raises (but lets a shutdown through)."""
        task_id = task["task_id"]
        clear_context()
        set_context(
            user_id=task["user_id"], conversation_id=task["conversation_id"], agent_slug=task["agent_slug"],
            task_id=task_id, task_run_id=active.run_id,
        )
        try:
            outcome = await self._execute(task_id, active)
        except asyncio.CancelledError:
            if not active.cancel_requested:
                raise
            _uncancel()
            outcome = RunOutcome(status="interrupted")
        except Exception:
            logger.error("async_task_run_crashed", "A background task run failed unexpectedly",
                         task_id=task_id, run_id=active.run_id, exc_info=True)
            outcome = RunOutcome(status="error", error=RUN_FAILED)
        await self._finish(task_id, active, outcome)

    async def _execute(self, task_id: str, active: _Active) -> RunOutcome:
        task = await self.store.get_task(task_id)
        if task is None:
            return RunOutcome(status="error", error=RUN_FAILED)
        try:
            agent = await self.build_agent(task, active.run_id)
        except (DefinitionUnavailable, UnknownTaskNode, ValueError, TypeError) as exc:
            logger.warning("async_task_build_failed", "Could not build a background task's agent",
                           task_id=task_id, error_type=type(exc).__name__)
            return RunOutcome(status="error", error=BUILD_FAILED)
        async with self._lock(task_id):
            if active.cancel_requested:
                return RunOutcome(status="interrupted")
            # From here on a follow-up interrupts this run instead of joining it.
            active.started = True
            inputs = list(active.inputs)
            await self.store.update_run(active.run_id, {"status": "running", "started_at": now()})
            fresh = await self.store.get_task(task_id)
            model_known = bool(fresh is not None and fresh.get("model"))
            if fresh is not None and fresh["status"] != "running":
                await self._set_status(fresh, "running")
        payload = {"messages": [_input_message(m) for m in inputs]}
        usage = _Usage()
        failed = False
        timeout = asyncio.timeout(settings.async_tasks.run_timeout_seconds)
        try:
            async with timeout, self._mcp_session() as session:
                live_tools = await load_mcp_tools(session) if session is not None else []
                agent.attach_tools(live_tools)
                async for frame in agent.astream(payload, command=active.command):
                    for event in parse_sse_frames(frame):
                        usage.observe(event)
                        if usage.model and not model_known:
                            # Recorded before settle, so the settle's TaskOut
                            # carries it and the bridge can price the usage.
                            model_known = True
                            await self.store.update_task(task_id, {"model": usage.model})
                        if event.get("type") == "RUN_ERROR":
                            failed = True
                        await self.publisher.task_event(task_id, event)
        except TimeoutError:
            return RunOutcome(status="timeout", error=RUN_TIMED_OUT, usage=usage.totals)
        # ``BaseAgent.astream`` ends quietly when cancelled, so a stop and the
        # watchdog are told apart from a finished run here, not by an exception.
        if active.cancel_requested:
            _uncancel()
            return RunOutcome(status="interrupted", usage=usage.totals)
        current = asyncio.current_task()
        if current is not None and current.cancelling():
            # Cancelled by nobody here: the process is shutting down. The run
            # stays active in the table; startup recovery settles it.
            raise asyncio.CancelledError
        if timeout.expired():
            return RunOutcome(status="timeout", error=RUN_TIMED_OUT, usage=usage.totals)
        if failed:
            return RunOutcome(status="error", error=RUN_FAILED, usage=usage.totals)
        snapshot = await agent.compiled.aget_state(agent.run_config)
        waiting = bool(list(getattr(snapshot, "interrupts", None) or []))
        await release_checkpoint_unless_paused(agent, active.run_id)
        values = getattr(snapshot, "values", None) or {}
        messages = list(values.get("messages") or [])
        result = message_dict(messages[-1]) if messages and not waiting else None
        tracked = values.get("async_tasks") or {}
        seen = frozenset(
            str(child_id) for child_id, record in tracked.items()
            if isinstance(record, Mapping) and record.get("status") in _TRACKED_SETTLED
        )
        return RunOutcome(status="success", waiting=waiting, usage=usage.totals, result=result, seen_settled=seen)

    async def build_agent(self, task: Mapping[str, Any], run_id: str) -> DeepAgent:
        """The task's node, built from the definition its tree is pinned to.

        Candidates are the current definition and then (a user-authored agent)
        its kept versions; the first whose fingerprint is the task's
        ``definition_version`` is used. None matching is a refusal — a task
        never silently runs a different agent than the one that started it.
        """
        context = task_context(task, run_id)
        config = {"context": context, "run_config": {"configurable": {"thread_id": task["task_id"]}}}
        owner = context.get("agent_owner_id")
        chosen: DeepAgent | None = None
        async for definition in definition_candidates(task["agent_slug"], owner):
            candidate = definition.build(config=config)
            if isinstance(candidate, DeepAgent) and candidate.definition_fingerprint() == task["definition_version"]:
                chosen = candidate
                break
        if chosen is None:
            raise DefinitionUnavailable(task["agent_slug"])
        chosen.async_task_node = TaskNode(
            task_id=task["task_id"],
            depth=int(task["depth"]),
            path=tuple(decode_path(task["subagent_path"])),
            user_id=task["user_id"],
            conversation_id=task["conversation_id"],
            root_run_id=task["root_run_id"],
            branch_thread_id=task["branch_thread_id"],
            agent_slug=task["agent_slug"],
            definition_version=task["definition_version"],
            inherited=InheritedContext.model_validate(task.get("context") or {}),
        )
        return chosen

    async def _finish(self, task_id: str, active: _Active, outcome: RunOutcome) -> None:
        """Record a run's end, then start the next queued run or evaluate the task."""
        follow_up: Callable[[], Awaitable[None]] | None = None
        async with self._lock(task_id):
            if self._active.get(task_id) is active:
                del self._active[task_id]
            metrics.record_active(len(self._active))
            run = await self.store.get_run(active.run_id)
            status = outcome.status
            fields: dict[str, Any] = {"usage": outcome.usage, "ended_at": now()}
            if run is not None and run["status"] in RUN_FINAL_STATUSES:
                status = run["status"]  # already ended by a stop or an interrupting update
            else:
                fields.update(status=status, error=outcome.error, waiting=outcome.waiting)
                if status == "success" and outcome.result is not None:
                    await self.store.update_task(task_id, {"result": outcome.result})
            await self.store.update_run(active.run_id, fields)
            task = await self.store.get_task(task_id)
            metrics.record_run_seconds(
                seconds=time.monotonic() - active.began, status=status, kind=active.kind,
                task_id=task_id, depth=int(task["depth"]) if task else 0,
            )
            if task is None:
                return
            if task["status"] == "cancelled":
                # A stop settles the task (and announces it) before the run it
                # interrupted gets here with that run's usage. Announce it again
                # so the bridge books the spend; it adds only the delta since
                # its last booking, so nothing is counted twice.
                if outcome.usage:
                    await self._publish("TASK_SETTLED", task_id)
                return
            if outcome.seen_settled is not None:
                await self._reconcile_deliveries(task_id, outcome.seen_settled)
            queued = self._queue.get(task_id)
            if queued:
                pending = queued.pop(0)
                if not queued:
                    self._queue.pop(task_id, None)
                await self._start(task, pending)
                return
            follow_up = await self._evaluate(task)
        if follow_up is not None:
            await follow_up()

    async def _reconcile_deliveries(self, task_id: str, seen: frozenset[str]) -> None:
        """Make ``parent_notified_at`` of ``task_id``'s children match what its run took in.

        A read of a settled child by the parent marks it delivered
        (``utils.async_tasks``), but a read the middleware abandoned (its pull
        timed out after ``runs.get`` answered) never reaches the model. The
        parent's own state is the truth: a child it records as finished was
        delivered; a settled child it does not record was not, and is taken
        back so ``_evaluate`` wakes the parent with it. A child the parent
        stopped itself (``cancel_reason="parent"``) needs no telling.
        """
        for child in await self.store.children(task_id):
            if child["status"] not in SETTLED_STATUSES:
                continue
            if child["task_id"] in seen:
                await self.store.mark_notified(child["task_id"])
            elif child.get("parent_notified_at") is not None and child.get("cancel_reason") != "parent":
                await self.store.clear_notified(child["task_id"])
                logger.info(
                    "async_task_delivery_taken_back", "A child's result never reached its parent; it will be woken",
                    task_id=task_id, child_task_id=child["task_id"],
                )

    # -- settling and waking ---------------------------------------------------
    async def _evaluate(self, task: dict[str, Any]) -> Callable[[], Awaitable[None]] | None:
        """Decide what a task with no run in flight is now (§3.5). Caller holds its lock.

        Returns the parent notification to run once the lock is released.
        """
        task_id = task["task_id"]
        if task["status"] in SETTLED_STATUSES or task_id in self._active:
            return None
        latest = next(iter(await self.store.list_runs(task_id, limit=1)), None)
        if latest is not None and latest["status"] == "success" and latest.get("waiting"):
            await self._set_status(task, "waiting")
            return None
        children = await self.store.children(task_id)
        undelivered = [
            c for c in children if c["status"] in SETTLED_STATUSES and c.get("parent_notified_at") is None
        ]
        if undelivered and task_id not in self._no_wake:
            # A child settled while this task was busy and its result was not
            # pulled in time: wake this task with it now (§3.5).
            await self._wake(task, undelivered[0])
            return None
        if any(c["status"] not in SETTLED_STATUSES for c in children):
            await self._set_status(task, "waiting_children")
            return None
        if latest is None:
            settled, error = "error", RUN_FAILED
        else:
            settled = _SETTLED_FROM_RUN.get(str(latest["status"]), "error")
            error = (latest.get("error") or RUN_FAILED) if settled == "error" else None
        preview = None
        if settled == "success":
            preview = text_preview(final_content(result_messages(task)), settings.async_tasks.result_preview_chars)
        await self._set_status(task, settled, settled_at=now(), result_preview=preview, error=error)
        await self.publisher.expire_events(task_id)
        logger.info("async_task_settled", "Background task settled", task_id=task_id, status=settled,
                    depth=task["depth"])
        return lambda: self._notify_parent(task_id)

    async def _wake(self, task: dict[str, Any], child: Mapping[str, Any]) -> None:
        """Start a run on ``task`` whose input is ``child``'s notification (caller holds the lock)."""
        message = await self.notification_for(child)
        await self.store.mark_notified(child["task_id"])
        pending = _Pending(run_id=str(uuid.uuid4()), kind="wake", inputs=[message])
        await self.store.insert_run({
            "run_id": pending.run_id, "task_id": task["task_id"], "kind": "wake",
            "multitask_strategy": None, "status": "pending",
        })
        logger.info("async_task_woken", "Woke a task with its child's result", task_id=task["task_id"],
                    child_task_id=child["task_id"])
        await self._start(task, pending)

    async def _notify_parent(self, task_id: str) -> None:
        """Tell a settled task's parent (§3.5). Runs with no lock held."""
        task = await self.store.get_task(task_id)
        if task is None or task.get("parent_notified_at") is not None or task["status"] not in SETTLED_STATUSES:
            return
        if task["parent_task_id"] is None:
            await self.publisher.outbox(await self.outbox_item(task))
            return
        await self._child_settled(task["parent_task_id"], task_id)

    async def _child_settled(self, parent_id: str, child_id: str) -> None:
        """A child of ``parent_id`` settled: wake the parent if nothing else will tell it."""
        follow_up: Callable[[], Awaitable[None]] | None = None
        async with self._lock(parent_id):
            parent = await self.store.get_task(parent_id)
            child = await self.store.get_task(child_id)
            if parent is None or child is None or child.get("parent_notified_at") is not None:
                return
            if parent["status"] in SETTLED_STATUSES:
                # A stopped parent has no one to report to.
                await self.store.mark_notified(child_id)
                return
            if parent_id in self._active or parent_id in self._no_wake:
                return  # its run pulls the result (or a restart cut it: recovery decides)
            if parent["status"] in ("waiting", "pending"):
                return  # woken after it resumes (_evaluate at its run's end)
            follow_up = await self._evaluate(parent)
        if follow_up is not None:
            await follow_up()

    # -- what the parent reads -------------------------------------------------
    async def notification_for(self, task: Mapping[str, Any]) -> dict[str, Any]:
        """The notification message for a settled task (``notification.py``)."""
        latest = next(iter(await self.store.list_runs(task["task_id"], limit=1)), None)
        status = task["status"] if task["status"] in SETTLED_STATUSES else "error"
        result = final_content(result_messages(task)) if status == "success" else None
        return build_notification(
            task_id=task["task_id"],
            agent_name=task["name"],
            status=status,
            run_id=latest["run_id"] if latest else None,
            result=result,
        )

    async def outbox_item(self, task: Mapping[str, Any]) -> dict[str, Any]:
        """The ``OutboxItem`` (§14.2) for a settled depth-1 task."""
        return {
            "task_id": task["task_id"],
            "user_id": task["user_id"],
            "conversation_id": task["conversation_id"],
            "branch_thread_id": task["branch_thread_id"],
            "root_run_id": task["root_run_id"],
            "agent_slug": task["agent_slug"],
            "interactive": bool(task.get("interactive", True)),
            "status": task["status"],
            "cancelled_by_user": task.get("cancel_reason") == "user",
            "notification": notification_payload(await self.notification_for(task)),
        }

    async def pending_interrupts(self, task: Mapping[str, Any]) -> list[Any]:
        """What a waiting task is paused on, read from its durable checkpoint."""
        agent = await self.build_agent(task, f"probe-{uuid.uuid4()}")
        await agent.ensure_built()
        snapshot = await agent.compiled.aget_state(agent.run_config)
        return list(snapshot.interrupts or [])

    async def interrupts_view(self, task: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
        """``Thread.interrupts`` of a waiting task: ``{task_id: [{id, value}]}``."""
        try:
            pending = await self.pending_interrupts(task)
        except (DefinitionUnavailable, UnknownTaskNode, ValueError) as exc:
            logger.warning("async_task_interrupts_unreadable", "Could not read a waiting task's interrupts",
                           task_id=task["task_id"], error_type=type(exc).__name__)
            return {}
        items = [{"id": str(getattr(i, "id", "")), "value": _jsonable(getattr(i, "value", None))} for i in pending]
        return {task["task_id"]: items} if items else {}

    # -- cancel, resume, recovery ---------------------------------------------
    async def cancel(self, task_id: str, reason: str) -> int:
        """Stop a task and its whole subtree (§3.9). Returns how many were stopped.

        ``reason``: ``parent`` (its parent's ``cancel_async_task``; the parent
        knows), ``user`` (the Stop button; D8: the orchestrator is not woken,
        the outbox item says ``cancelled_by_user``), ``scope`` (conversation
        delete, account purge; nobody is told).
        """
        cancelled = 0
        for tid in await self.store.subtree_ids(task_id):
            async with self._lock(tid):
                task = await self.store.get_task(tid)
                if task is None or task["status"] in SETTLED_STATUSES:
                    continue
                for dropped in self._queue.pop(tid, []):
                    await self.store.update_run(dropped.run_id, {"status": "interrupted", "ended_at": now()})
                active = self._active.get(tid)
                if active is not None:
                    await self._stop_active(active)
                fields: dict[str, Any] = {"settled_at": now(), "cancel_reason": reason if tid == task_id else "cascade"}
                if tid != task_id or reason != "user":
                    fields["parent_notified_at"] = now()
                await self._set_status(task, "cancelled", **fields)
                await self.publisher.expire_events(tid)
                cancelled += 1
        logger.info("async_task_cancelled", "Background task stopped with its subtree", task_id=task_id,
                    reason=reason, cancelled=cancelled)
        if reason == "user" and cancelled:
            await self._notify_parent(task_id)
        return cancelled

    async def resume(self, task: Mapping[str, Any], decisions: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
        """Answer a waiting task's approval (§3.8): a ``resume`` run with ``Command(resume=...)``.

        The answers are checked against the checkpoint's pending interrupts
        (a stale one is a 409, as for a top-level run) with the same helper
        the ``/agents/{slug}/resume`` route uses.
        """
        task_id = task["task_id"]
        async with self._lock(task_id):
            fresh = await self.store.get_task(task_id)
            if fresh is None:
                raise TaskRefused(404, "Not found.")
            if fresh["status"] != "waiting" or task_id in self._active:
                raise TaskRefused(409, "The task is not waiting for an approval.")
            if await self.store.count_runs(task_id) >= settings.async_tasks.max_runs_per_task:
                raise TaskRefused(429, "This task has had too many runs.")
            try:
                pending_interrupts = await self.pending_interrupts(fresh)
            except (DefinitionUnavailable, UnknownTaskNode) as exc:
                raise TaskRefused(409, "The task can no longer be resumed.") from exc
            if not pending_interrupts:
                raise TaskRefused(409, "The task is not waiting for an approval.")
            items = [ResumeItem(interrupt_id=key, **dict(value)) for key, value in decisions.items()]
            first = items[0]
            request = AgentResumeRequest(
                config={}, thread_id=task_id, decision=first.decision, reason=first.reason,
                value=first.value, interrupt_id=first.interrupt_id, resumes=items,
            )
            try:
                command = build_resume_command(request, pending_interrupts, logger)
            except HTTPException as exc:
                raise TaskRefused(exc.status_code, "The approval does not match what the task is waiting for.") from exc
            pending = _Pending(run_id=str(uuid.uuid4()), kind="resume", inputs=[], command=command)
            await self.store.insert_run({
                "run_id": pending.run_id, "task_id": task_id, "kind": "resume",
                "multitask_strategy": None, "status": "pending",
            })
            await self._start(fresh, pending)
            updated = await self.store.get_task(task_id)
        return updated or dict(task)

    async def recover(self) -> None:
        """Startup (§3.8): runs a restart cut become errors, and their tasks settle.

        No run survives a restart in this process, so every pending or running
        run is an ``error("interrupted by restart")``. Their tasks are then
        evaluated deepest first: they settle as error and notify their parent
        — but are never woken (the parent decides whether to continue, with
        ``update_async_task``). A ``waiting`` task stays waiting: its pause is
        in the durable checkpoint.
        """
        cut = await self.store.fail_unfinished_runs(RUN_RESTARTED)
        self._no_wake = set(cut)
        try:
            for task_id in await self.store.unsettled_task_ids():
                follow_up: Callable[[], Awaitable[None]] | None = None
                async with self._lock(task_id):
                    task = await self.store.get_task(task_id)
                    if task is None or task["status"] not in ACTIVE_STATUSES:
                        continue
                    follow_up = await self._evaluate(task)
                if follow_up is not None:
                    await follow_up()
        finally:
            self._no_wake = set()
        if cut:
            logger.info("async_tasks_recovered", "Settled background tasks a restart interrupted", count=len(cut))


def task_out_from_row(task: Mapping[str, Any], usage: Mapping[str, int]) -> dict[str, Any]:
    """A task row as ``TaskOut`` (§14.1) data."""
    path = decode_path(task["subagent_path"])
    return {
        "task_id": task["task_id"],
        "conversation_id": task["conversation_id"],
        "user_id": task["user_id"],
        "parent_task_id": task.get("parent_task_id"),
        "root_run_id": task["root_run_id"],
        "branch_thread_id": task["branch_thread_id"],
        "spawned_by_message_id": task["root_run_id"],
        "depth": int(task["depth"]),
        "name": task.get("name") or (path[-1] if path else ""),
        "subagent_path": display_path(path),
        "description": task.get("description"),
        "model": task.get("model"),
        "status": task["status"],
        "result_preview": task.get("result_preview"),
        "error": task.get("error"),
        "usage": {key: int(value) for key, value in usage.items()},
        "started_at": task["created_at"],
        "settled_at": task.get("settled_at"),
    }


def message_dict(message: Any) -> dict[str, Any]:
    """A LangChain message as plain data (``convert_to_messages`` reads it back)."""
    if hasattr(message, "model_dump"):
        return _jsonable(message.model_dump())
    return _jsonable(dict(message)) if isinstance(message, Mapping) else {"type": "ai", "content": str(message)}


def result_messages(task: Mapping[str, Any]) -> list[dict[str, Any]]:
    """A task's result as a message list: its final message, or nothing yet."""
    result = task.get("result")
    return [result] if isinstance(result, dict) else []


def _message_text(message: Mapping[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(b.get("text") or "") for b in content if isinstance(b, Mapping))
    return ""


def _input_message(message: Mapping[str, Any]) -> Any:
    """A queued input as graph input: a notification keeps its metadata."""
    if message.get("additional_kwargs"):
        return to_human_message(message)
    return {"role": "user", "content": message.get("content")}


def _uncancel() -> None:
    """Clear the cancellation this task absorbed, so its bookkeeping can still await."""
    current = asyncio.current_task()
    if current is not None and current.cancelling():
        current.uncancel()


# The process-wide runner, installed by the lifespan.
_runner: TaskRunner | None = None


def set_task_runner(runner: TaskRunner | None) -> None:
    global _runner
    _runner = runner


def optional_task_runner() -> TaskRunner | None:
    """The runner, or ``None`` when async sub-agents are off."""
    return _runner


def get_task_runner() -> TaskRunner:
    """The runner, or a 503 when async sub-agents are off or not started yet."""
    if _runner is None:
        raise HTTPException(status_code=503, detail="Background tasks are not available.")
    return _runner
