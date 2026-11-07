"""Endpoint logic for ``/ap`` (the Agent Protocol subset) and ``/tasks`` (the bridge's task API).

Plan 41 §3.2, §3.3, §5, §14.3. The routers stay thin; everything they do is here.

**Who may do what.** Every ``/ap`` call carries a task-launch token
(``harness.async_tasks.token``) — the caller's identity, never read from the
body — and every call on an existing task is authorised against its row:
same user, same conversation, and the caller *is the task's parent* (the
orchestrator on the task's branch for a depth-1 task, the parent task
otherwise). Anything else is a 404, so a task id reveals nothing to anyone but
its parent. The ``/tasks`` routes are the bridge's: ``require_internal_caller``
plus the ``user_id`` in each request checked against the row.

**Settle-only reporting (D3).** A task whose own run ended while a child is
still working is ``waiting_children``; its thread reads ``busy`` and its latest
run reads ``success`` (a failed run is masked until the subtree settles), so
deepagents reports it as running and the parent hears once, when it settles.

**Delivery by pull.** When the parent reads a settled task — its middleware's
pull before a model call, ``check_async_task``, ``list_async_tasks`` — the
result has reached it, so ``parent_notified_at`` is set here and no wake-up
follows (the bridge's run-end hook and reconcile read that column).
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import HTTPException, Request, status

from core.logging import get_logger
from harness.async_tasks.runner import (
    TaskRefused,
    TaskRunner,
    get_task_runner,
    optional_task_runner,
    result_messages,
    task_out_from_row,
)
from harness.async_tasks.specs import decode_path, graph_id_for
from harness.async_tasks.store import SETTLED_STATUSES
from harness.async_tasks.token import (
    LAUNCH_TOKEN_HEADER,
    LaunchClaims,
    LaunchTokenError,
    verify_launch_token,
)
from schema.agent_protocol import RunCreateIn, RunOut, ThreadCreateIn, ThreadOut
from schema.async_tasks import (
    OutboxItem,
    TaskCancelIn,
    TaskCancelScopeIn,
    TaskCancelScopeOut,
    TaskOut,
    TaskResumeIn,
)

logger = get_logger(__name__)

#: ``runs.list`` page size, at most.
MAX_RUNS_PAGE = 100
#: ``GET /tasks`` page size, at most.
MAX_TASKS_PAGE = 500
#: ``GET /tasks/unnotified`` page size, at most.
MAX_UNNOTIFIED = 1000

_NOT_FOUND = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")


# ---------------------------------------------------------------------------
# Authentication and authorisation
# ---------------------------------------------------------------------------
def launch_claims(request: Request) -> LaunchClaims:
    """FastAPI dependency: the verified caller of an ``/ap`` request (401 otherwise)."""
    try:
        return verify_launch_token(request.headers.get(LAUNCH_TOKEN_HEADER))
    except LaunchTokenError as exc:
        logger.warning("ap_launch_token_rejected", "Refused an Agent Protocol call", reason=str(exc))
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized.") from exc


def is_parent(claims: LaunchClaims, task: Mapping[str, Any]) -> bool:
    """Whether the caller is ``task``'s parent — the only one that may touch it."""
    if task["user_id"] != claims.user_id or task["conversation_id"] != claims.conversation_id:
        return False
    if task["agent_slug"] != claims.agent_slug or task["definition_version"] != claims.definition_version:
        return False
    if task.get("parent_task_id") is None:
        return claims.caller_task_id is None and task["branch_thread_id"] == claims.branch_thread_id
    return claims.caller_task_id == task["parent_task_id"]


async def _child_task(runner: TaskRunner, claims: LaunchClaims, thread_id: str) -> dict[str, Any]:
    task = await runner.store.get_task(thread_id)
    if task is None or not is_parent(claims, task):
        raise _NOT_FOUND
    return task


def _refused(exc: TaskRefused) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


# ---------------------------------------------------------------------------
# Protocol views of a task
# ---------------------------------------------------------------------------
def thread_status(task: Mapping[str, Any]) -> str:
    """A task's status as an Agent Protocol thread status (§3.2)."""
    current = task["status"]
    if current == "waiting":
        return "interrupted"
    if current == "error":
        return "error"
    if current in ("success", "cancelled"):
        return "idle"
    return "busy"


def run_view(task: Mapping[str, Any], run: Mapping[str, Any], latest_run_id: str | None) -> RunOut:
    """A run as an Agent Protocol run, masked while its task's subtree is unsettled."""
    run_status = str(run["status"])
    if run["run_id"] == latest_run_id and task["status"] == "waiting_children" and run_status in ("error", "timeout"):
        run_status = "success"
    error = run.get("error") if run_status in ("error", "timeout") else None
    return RunOut(
        run_id=run["run_id"],
        thread_id=task["task_id"],
        assistant_id=graph_id_for(task["agent_slug"], task["definition_version"], decode_path(task["subagent_path"])),
        created_at=run["created_at"],
        updated_at=run.get("ended_at") or run.get("started_at") or run["created_at"],
        status=run_status,
        multitask_strategy=run.get("multitask_strategy"),
        metadata={"kind": run.get("kind")},
        error=error,
    )


async def thread_view(runner: TaskRunner, task: Mapping[str, Any]) -> ThreadOut:
    """A task as an Agent Protocol thread: its status, and what deepagents reads —
    the final message once it succeeded, the pending interrupts while it waits."""
    values: dict[str, Any] | None = None
    interrupts: dict[str, list[dict[str, Any]]] = {}
    if task["status"] == "success":
        values = {"messages": result_messages(task)}
    elif task["status"] == "waiting":
        interrupts = await runner.interrupts_view(task)
    return ThreadOut(
        thread_id=task["task_id"],
        created_at=task["created_at"],
        updated_at=task.get("updated_at") or task["created_at"],
        metadata={"subagent_name": task.get("name") or "", "depth": task["depth"]},
        status=thread_status(task),
        values=values,
        interrupts=interrupts,
    )


async def _delivered(runner: TaskRunner, task: Mapping[str, Any]) -> None:
    """The parent has read the settled task: record the delivery (see module doc)."""
    settled_unseen = task["status"] in SETTLED_STATUSES and task.get("parent_notified_at") is None
    if settled_unseen and await runner.store.mark_notified(task["task_id"]):
        logger.info("async_task_delivered_by_pull", "A settled task's result reached its parent",
                    task_id=task["task_id"])


# ---------------------------------------------------------------------------
# /ap — the six calls deepagents makes
# ---------------------------------------------------------------------------
async def ap_create_thread(claims: LaunchClaims, body: ThreadCreateIn) -> ThreadOut:
    """``threads.create``: a new task, child of the caller."""
    runner = get_task_runner()
    try:
        task = await runner.create_task(claims, body.metadata.subagent_name)
    except TaskRefused as exc:
        raise _refused(exc) from exc
    return await thread_view(runner, task)


async def ap_get_thread(claims: LaunchClaims, thread_id: str) -> ThreadOut:
    """``threads.get``."""
    runner = get_task_runner()
    task = await _child_task(runner, claims, thread_id)
    view = await thread_view(runner, task)
    await _delivered(runner, task)
    return view


async def ap_create_run(claims: LaunchClaims, thread_id: str, body: RunCreateIn) -> RunOut:
    """``runs.create``: start, follow-up (interrupt, enqueue, pending guard) or reopen."""
    runner = get_task_runner()
    task = await _child_task(runner, claims, thread_id)
    if body.command is not None:
        # An approval is the user's (bridge → /tasks/{id}/resume), never a
        # parent model's: no tool of the middleware sends one, so refuse.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Approvals are answered by the user.")
    if body.webhook is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Webhooks are not supported.")
    if body.input is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A run needs input messages.")
    try:
        run = await runner.create_run(
            task,
            assistant_id=body.assistant_id,
            messages=[m.model_dump() for m in body.input.messages],
            strategy=body.multitask_strategy or "interrupt",
        )
    except TaskRefused as exc:
        raise _refused(exc) from exc
    fresh = await runner.store.get_task(thread_id) or task
    return run_view(fresh, run, run["run_id"])


async def _latest_run_id(runner: TaskRunner, task_id: str) -> str | None:
    latest = await runner.store.list_runs(task_id, limit=1)
    return latest[0]["run_id"] if latest else None


async def ap_get_run(claims: LaunchClaims, thread_id: str, run_id: str) -> RunOut:
    """``runs.get``."""
    runner = get_task_runner()
    task = await _child_task(runner, claims, thread_id)
    run = await runner.store.get_run(run_id)
    if run is None or run["task_id"] != task["task_id"]:
        raise _NOT_FOUND
    latest = await _latest_run_id(runner, task["task_id"])
    if run_id == latest:
        await _delivered(runner, task)
    return run_view(task, run, latest)


async def ap_list_runs(claims: LaunchClaims, thread_id: str, limit: int, offset: int) -> list[RunOut]:
    """``runs.list``: newest first."""
    runner = get_task_runner()
    task = await _child_task(runner, claims, thread_id)
    runs = await runner.store.list_runs(task["task_id"], limit=max(1, min(limit, MAX_RUNS_PAGE)), offset=max(0, offset))
    latest = await _latest_run_id(runner, task["task_id"])
    if runs and runs[0]["run_id"] == latest:
        await _delivered(runner, task)
    return [run_view(task, run, latest) for run in runs]


async def ap_cancel_run(claims: LaunchClaims, thread_id: str, run_id: str) -> RunOut | None:
    """``runs.cancel``: the parent's ``cancel_async_task`` — the task and its subtree.

    An already-ended (superseded) run is left alone. The parent asked for it,
    so the settle is recorded as delivered and nobody is woken.
    """
    runner = get_task_runner()
    task = await _child_task(runner, claims, thread_id)
    run = await runner.store.get_run(run_id)
    if run is None or run["task_id"] != task["task_id"]:
        raise _NOT_FOUND
    latest = await _latest_run_id(runner, task["task_id"])
    if run_id == latest and task["status"] not in SETTLED_STATUSES:
        await runner.cancel(task["task_id"], "parent")
    fresh_task = await runner.store.get_task(task["task_id"]) or task
    fresh_run = await runner.store.get_run(run_id) or run
    return run_view(fresh_task, fresh_run, latest)


# ---------------------------------------------------------------------------
# /tasks — the bridge's task API (§14.3)
# ---------------------------------------------------------------------------
async def _users_task(runner: TaskRunner, task_id: str, user_id: str) -> dict[str, Any]:
    task = await runner.store.get_task(task_id)
    if task is None or task["user_id"] != user_id:
        raise _NOT_FOUND
    return task


async def tasks_get(task_id: str, user_id: str) -> TaskOut:
    runner = get_task_runner()
    return TaskOut.model_validate(await runner.task_out(await _users_task(runner, task_id, user_id)))


async def tasks_list(user_id: str, conversation_id: str, limit: int) -> list[TaskOut]:
    runner = get_task_runner()
    tasks = await runner.store.list_tasks(user_id, conversation_id, max(1, min(limit, MAX_TASKS_PAGE)))
    usage = await runner.store.usage_totals([t["task_id"] for t in tasks])
    return [TaskOut.model_validate(task_out_from_row(t, usage.get(t["task_id"], {}))) for t in tasks]


async def tasks_unnotified(limit: int, user_id: str | None, conversation_id: str | None) -> list[OutboxItem]:
    """Settled depth-1 tasks the orchestrator has not been told about (startup reconcile).

    Empty while async sub-agents are off, so the bridge's reconcile loop is a no-op.
    """
    runner = optional_task_runner()
    if runner is None:
        return []
    rows = await runner.store.unnotified(
        max(1, min(limit, MAX_UNNOTIFIED)), user_id=user_id, conversation_id=conversation_id
    )
    return [OutboxItem.model_validate(await runner.outbox_item(row)) for row in rows]


async def tasks_mark_notified(task_id: str, user_id: str) -> None:
    runner = get_task_runner()
    task = await _users_task(runner, task_id, user_id)
    await runner.store.mark_notified(task["task_id"])


async def tasks_cancel(task_id: str, body: TaskCancelIn) -> TaskOut:
    """The Stop button: the task and its subtree (D8: the orchestrator is not woken)."""
    runner = get_task_runner()
    task = await _users_task(runner, task_id, body.user_id)
    await runner.cancel(task["task_id"], body.reason)
    return TaskOut.model_validate(await runner.task_out(await _users_task(runner, task_id, body.user_id)))


async def tasks_resume(task_id: str, body: TaskResumeIn) -> TaskOut:
    """An approval for a waiting task (§3.8)."""
    runner = get_task_runner()
    task = await _users_task(runner, task_id, body.user_id)
    try:
        updated = await runner.resume(task, {key: value.model_dump() for key, value in body.decisions.items()})
    except TaskRefused as exc:
        raise _refused(exc) from exc
    return TaskOut.model_validate(await runner.task_out(updated))


async def tasks_cancel_scope(body: TaskCancelScopeIn) -> TaskCancelScopeOut:
    """Every task of a conversation, a root run, or (neither given) the whole account.

    With async sub-agents off no task can be running, so there is nothing to stop.
    """
    runner = optional_task_runner()
    if runner is None:
        return TaskCancelScopeOut(cancelled=0)
    roots: Sequence[str] = await runner.store.scope_task_ids(
        body.user_id, conversation_id=body.conversation_id, root_run_id=body.root_run_id
    )
    cancelled = 0
    for task_id in roots:
        cancelled += await runner.cancel(task_id, "scope")
    return TaskCancelScopeOut(cancelled=cancelled)


__all__ = [
    "ap_cancel_run",
    "ap_create_run",
    "ap_create_thread",
    "ap_get_run",
    "ap_get_thread",
    "ap_list_runs",
    "is_parent",
    "launch_claims",
    "run_view",
    "tasks_cancel",
    "tasks_cancel_scope",
    "tasks_get",
    "tasks_list",
    "tasks_mark_notified",
    "tasks_resume",
    "tasks_unnotified",
    "thread_status",
    "thread_view",
]
