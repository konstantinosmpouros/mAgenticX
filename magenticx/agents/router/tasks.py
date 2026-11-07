"""``/tasks`` — the bridge's internal API over background tasks (plan 41 §14.3).

``require_internal_caller`` on every route, and the acting ``user_id`` in each
request is checked against the task row (a mismatch is a 404). Logic lives in
``utils.async_tasks``.
"""

from fastapi import APIRouter, Depends, Query, Response, status

from core.security.internal_trust import require_internal_caller
from schema import (
    OutboxItem,
    TaskCancelIn,
    TaskCancelScopeIn,
    TaskCancelScopeOut,
    TaskOut,
    TaskResumeIn,
    TaskUserIn,
)
from utils.async_tasks import (
    tasks_cancel,
    tasks_cancel_scope,
    tasks_get,
    tasks_list,
    tasks_mark_notified,
    tasks_resume,
    tasks_unnotified,
)

router = APIRouter(prefix="/tasks", dependencies=[Depends(require_internal_caller)])


@router.get("/unnotified", response_model=list[OutboxItem])
async def list_unnotified(
    limit: int = Query(100, ge=1, le=1000),
    user_id: str | None = Query(None, min_length=1, max_length=256),
    conversation_id: str | None = Query(None, min_length=1, max_length=256),
) -> list[OutboxItem]:
    """Settled depth-1 tasks the orchestrator has not been told about."""
    return await tasks_unnotified(limit, user_id, conversation_id)


@router.post("/cancel-scope", response_model=TaskCancelScopeOut)
async def cancel_scope(body: TaskCancelScopeIn) -> TaskCancelScopeOut:
    """Stop every task of a conversation, a root run, or a whole account."""
    return await tasks_cancel_scope(body)


@router.get("", response_model=list[TaskOut])
async def list_tasks(
    user_id: str = Query(..., min_length=1, max_length=256),
    conversation_id: str = Query(..., min_length=1, max_length=256),
    limit: int = Query(200, ge=1, le=500),
) -> list[TaskOut]:
    """A conversation's tasks, oldest first."""
    return await tasks_list(user_id, conversation_id, limit)


@router.get("/{task_id}", response_model=TaskOut)
async def get_task(task_id: str, user_id: str = Query(..., min_length=1, max_length=256)) -> TaskOut:
    """One task (404 when it is not that user's)."""
    return await tasks_get(task_id, user_id)


@router.post("/{task_id}/notified", status_code=status.HTTP_204_NO_CONTENT)
async def mark_notified(task_id: str, body: TaskUserIn) -> Response:
    """The bridge woke the orchestrator with this task's settle."""
    await tasks_mark_notified(task_id, body.user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{task_id}/cancel", response_model=TaskOut)
async def cancel_task(task_id: str, body: TaskCancelIn) -> TaskOut:
    """The Stop button: the task and its whole subtree."""
    return await tasks_cancel(task_id, body)


@router.post("/{task_id}/resume", response_model=TaskOut)
async def resume_task(task_id: str, body: TaskResumeIn) -> TaskOut:
    """An approval decision for a waiting task."""
    return await tasks_resume(task_id, body)
