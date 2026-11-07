"""Background sub-agent tasks (plan 41 §5, §14.4): REST and WebSockets.

Thin: every route checks the session, the user binding and ownership, and
hands the work to ``utils/async_tasks.py`` / ``utils/composer_queue.py``;
the sockets' handshake, ownership and pump live in ``utils/task_sockets.py``. Two
routers, because half the surface hangs off a conversation:

* ``router`` (``/v1/tasks``) — one task: stop it, answer its approval, watch
  its live events (the drill-down socket);
* ``conversation_router`` (``/v1/conversations``) — a conversation's task
  tree, its queued composer message, and the conversation channel socket.

Both sockets authenticate exactly like the run socket (router/inference.py):
session cookie bound to the path's ``{user_id}``, a per-user connect-rate
limit, ownership checked before the handshake completes, then a ``subscribe``
first frame within ``INFERENCE_WS_SUBSCRIBE_TIMEOUT_SECONDS``.
"""
from fastapi import APIRouter, Depends, Query, Response, WebSocket, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection
from core.database import get_db
from core.logging import get_logger, set_context
from core.security.rate_limit import task_mutate_rate_limit, task_read_rate_limit
from schema import ActiveConversationsOut, TaskOut, TaskResumeIn
from utils import validate_userId
from utils.async_tasks import (
    active_conversation_ids,
    cancel_task_for_user,
    list_conversation_tasks,
    resume_task_for_user,
    stream_task_events,
)
from utils.composer_queue import cancel_queued_message
from utils.conversation_channel import channel_frames
from utils.task_sockets import (
    accept_subscribe,
    authenticate_socket,
    conversation_socket_queue,
    pump_frames,
    task_socket_owned,
)

logger = get_logger(__name__)

router = APIRouter()
conversation_router = APIRouter()

# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------
@conversation_router.get("/{user_id}/{conversation_id}/tasks", response_model=list[TaskOut])
async def listConversationTasks(
    user_id: str,
    conversation_id: str,
    limit: int = Query(default=200, ge=1),
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(task_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> list[TaskOut]:
    """The conversation's background task tree, from the bridge's mirror."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    return await list_conversation_tasks(db, current_user.id, conversation_id, limit)


@conversation_router.delete("/{user_id}/{conversation_id}/queued-message", status_code=status.HTTP_204_NO_CONTENT)
async def deleteQueuedMessage(
    user_id: str,
    conversation_id: str,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(task_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Cancel the conversation's queued composer message before it is sent."""
    set_context(user_id=user_id, conversation_id=conversation_id)
    await cancel_queued_message(db, current_user.id, conversation_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{user_id}/active-conversations", response_model=ActiveConversationsOut)
async def listActiveConversations(
    user_id: str,
    current_user: AuthUser = Depends(validate_userId),
    _rate_limited: None = Depends(task_read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> ActiveConversationsOut:
    """The caller's conversations whose background tasks are still working."""
    set_context(user_id=user_id)
    return await active_conversation_ids(db, current_user.id)


@router.post("/{user_id}/{task_id}/cancel", response_model=TaskOut)
async def cancelTask(
    user_id: str,
    task_id: str,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(task_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    """The Stop button: cancel a task and its whole subtree."""
    set_context(user_id=user_id)
    return await cancel_task_for_user(db, current_user.id, task_id)


@router.post("/{user_id}/{task_id}/resume", response_model=TaskOut)
async def resumeTask(
    user_id: str,
    task_id: str,
    payload: TaskResumeIn,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    _rate_limited: None = Depends(task_mutate_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    """Answer the approval a ``waiting`` task is paused on."""
    set_context(user_id=user_id)
    return await resume_task_for_user(db, current_user.id, task_id, payload)


# ---------------------------------------------------------------------------
# WebSockets
# ---------------------------------------------------------------------------
@conversation_router.websocket("/{user_id}/{conversation_id}/ws")
async def conversation_websocket(websocket: WebSocket, user_id: str, conversation_id: str):
    """The conversation channel (§14.4): ``task``, ``run_started`` and
    ``queue`` frames, each with its ``seq`` (send it back as ``since`` to
    resume after a reconnect). The first frame is always the queue's state."""
    if not await authenticate_socket(websocket, user_id):
        return
    owned, queued = await conversation_socket_queue(websocket, user_id, conversation_id)
    if not owned:
        return
    ok, since = await accept_subscribe(websocket)
    if not ok:
        return
    set_context(user_id=user_id, conversation_id=conversation_id)
    logger.info("conversation_ws_subscribe", "Conversation channel subscriber attached", replay=bool(since))
    await pump_frames(websocket, channel_frames(conversation_id, since, queued), conversation_id=conversation_id)


@router.websocket("/{user_id}/{task_id}/ws")
async def task_websocket(websocket: WebSocket, user_id: str, task_id: str):
    """One task's live events, for its drill-down (§14.4): ``snapshot``, then
    ``event`` frames, then ``terminal`` once it settles."""
    if not await authenticate_socket(websocket, user_id):
        return
    if not await task_socket_owned(websocket, user_id, task_id):
        return
    ok, since = await accept_subscribe(websocket)
    if not ok:
        return
    set_context(user_id=user_id)
    logger.info("task_ws_subscribe", "Task socket subscriber attached", task_id=task_id, replay=bool(since))
    await pump_frames(websocket, stream_task_events(user_id, task_id, since), task_id=task_id)
