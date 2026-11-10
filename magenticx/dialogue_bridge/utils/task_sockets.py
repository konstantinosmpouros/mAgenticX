"""WebSocket plumbing of the background-task sockets (plan 41 §14.4).

The conversation channel (``/v1/conversations/{user_id}/{conversation_id}/ws``)
and one task's drill-down (``/v1/tasks/{user_id}/{task_id}/ws``) share one
lifecycle, the run socket's (router/inference.py):

1. **authenticate**: the session cookie is bound to the path's ``{user_id}``,
   and a per-user connect-rate limit applies;
2. **ownership**: checked before the handshake completes, so a socket for
   someone else's conversation or task closes with 4404 and learns nothing;
3. **subscribe**: the first client frame must be ``{"type": "subscribe",
   "since"?}`` within ``INFERENCE_WS_SUBSCRIBE_TIMEOUT_SECONDS``;
4. **pump**: frames are sent until they end or the client goes away.

The router keeps only the endpoints; this module holds the steps, so both
sockets follow them identically.
"""
import asyncio
from typing import Any, AsyncIterator, Optional

from fastapi import WebSocket, WebSocketDisconnect

from core.auth.session import authenticate_websocket_user, websocket_origin_allowed
from core.database import SessionLocal
from core.logging import get_logger
from core.security.rate_limit import allow_ws_connect
from core.settings import settings
from schema import QueuedMessageOut, queued_message_from_column
from utils.async_tasks import get_owned_task, owned_conversation

logger = get_logger(__name__)

# The run socket's close codes (RFC 6455 application range, HTTP-like).
WS_UNAUTHORIZED = 4401
WS_FORBIDDEN = 4403
WS_NOT_FOUND = 4404
WS_BAD_REQUEST = 4400
WS_RATE_LIMITED = 4429

# A `since` cursor is a Redis stream id; anything longer is not one.
_MAX_SINCE_LENGTH = 64


async def authenticate_socket(websocket: WebSocket, user_id: str) -> bool:
    """Origin, session and connect-rate checks of the socket; closes on failure."""
    if not websocket_origin_allowed(websocket.headers):
        await websocket.close(code=WS_FORBIDDEN, reason="Origin not allowed")
        return False
    if await authenticate_websocket_user(websocket.cookies, user_id) is None:
        await websocket.close(code=WS_UNAUTHORIZED, reason="Authentication required")
        return False
    if not await allow_ws_connect(websocket, user_id):
        await websocket.close(code=WS_RATE_LIMITED, reason="Too many connections; retry shortly")
        return False
    return True


async def conversation_socket_queue(
    websocket: WebSocket, user_id: str, conversation_id: str
) -> tuple[bool, Optional[QueuedMessageOut]]:
    """Ownership check of the conversation channel, plus the queue state its
    first frame carries. Returns ``(owned, queued)``; closes with 4404 when the
    conversation is not the user's."""
    async with SessionLocal() as db:
        conversation = await owned_conversation(db, user_id, conversation_id)
        queued = queued_message_from_column(conversation.queued_message) if conversation is not None else None
    if conversation is None:
        await websocket.close(code=WS_NOT_FOUND, reason="Conversation not found")
        return False, None
    return True, queued


async def task_socket_owned(websocket: WebSocket, user_id: str, task_id: str) -> bool:
    """Ownership check of a task's drill-down socket; closes with 4404 when the
    task is not the user's."""
    async with SessionLocal() as db:
        owned = await get_owned_task(db, user_id, task_id) is not None
    if not owned:
        await websocket.close(code=WS_NOT_FOUND, reason="Task not found")
    return owned


async def accept_subscribe(websocket: WebSocket) -> tuple[bool, Optional[str]]:
    """Accept and read the first frame: ``{"type": "subscribe", "since"?}``.
    Returns ``(ok, since)``; closes the socket when the frame is missing or wrong."""
    await websocket.accept()
    try:
        first = await asyncio.wait_for(
            websocket.receive_json(), timeout=settings.inference.ws_subscribe_timeout_seconds
        )
    except asyncio.TimeoutError:
        await websocket.close(code=WS_BAD_REQUEST, reason="No subscribe frame in time")
        return False, None
    except WebSocketDisconnect:
        return False, None
    except ValueError:
        await websocket.close(code=WS_BAD_REQUEST, reason="Invalid subscribe frame")
        return False, None
    if not isinstance(first, dict) or first.get("type") != "subscribe":
        await websocket.close(code=WS_BAD_REQUEST, reason="First frame must be subscribe")
        return False, None
    since = first.get("since")
    return True, since if isinstance(since, str) and since and len(since) <= _MAX_SINCE_LENGTH else None


async def _until_disconnect(websocket: WebSocket) -> None:
    """Read (and ignore) client frames until the client goes away."""
    while True:
        message = await websocket.receive()
        if message.get("type") == "websocket.disconnect":
            return


async def pump_frames(websocket: WebSocket, frames: AsyncIterator[dict[str, Any]], **log_fields: Any) -> None:
    """Send ``frames`` until they end or the client disconnects, then close.

    The sender and a reader of client frames race: whichever ends first ends
    the socket, so a client that leaves never keeps a Redis read open.
    """
    async def send_all() -> None:
        async for frame in frames:
            await websocket.send_json(frame)

    sender = asyncio.create_task(send_all())
    receiver = asyncio.create_task(_until_disconnect(websocket))
    try:
        done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if sender in done and sender.exception() is not None:
            exc = sender.exception()
            if not isinstance(exc, WebSocketDisconnect):
                logger.error("task_ws_stream_failed", "Task socket stream failed", exc_info=exc, **log_fields)
                await websocket.close(code=1011, reason="Stream failed")
                return
    finally:
        for task in (sender, receiver):
            if not task.done():
                task.cancel()
    if sender.done() and not sender.cancelled():
        try:
            await websocket.close()
        except (RuntimeError, WebSocketDisconnect):
            pass  # the client closed first
