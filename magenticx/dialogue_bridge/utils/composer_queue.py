"""The composer's one queued message (plan 41 §3.6).

While a conversation has an active run — usually a wake-up run reporting a
background task's result — a message the user sends is not refused: with
``queue_if_busy`` it is held in ``conversations.queued_message`` and sent as a
normal ``send`` when that run ends, on the leaf the run produced.

* **One slot.** A second send replaces the first; ``DELETE …/queued-message``
  cancels it. No reordering, no list.
* **Durable.** It is a column, so it survives a bridge restart; the reconcile
  loop sends what a restart (or a missed run-end) left behind.
* **Sent exactly once.** Sending first *claims* the slot with an atomic
  ``UPDATE … WHERE queued_message IS NOT NULL RETURNING`` — the run-end hook,
  the loop and the queue route can race, and only one of them gets it. When
  the send is refused for a transient reason (another run started first: 409;
  the user's run cap: 429) it is put back, unless a newer one took the slot.
* **Text and a slash command only.** Attachment bytes are never parked in a
  JSON column: a send with attachments to a busy conversation gets today's 409.

The composer shows the slot through ``queue`` frames on the conversation
channel.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ConversationTable, MessageTable, SessionLocal, UserTable
from core.logging import get_logger
from schema import (
    InferenceStartPayload,
    MessageIn,
    QueuedMessageOut,
    QueuedStartResponse,
    queued_message_from_column,
)
from utils.agents import get_agent_by_id
from utils.commands import check_invocation
from utils.conversation_channel import publish_queue, publish_run_started
from utils.inference_runs import ACTIVE_RUN_STATUSES, inference_run_manager
from utils.inference_start import start_inference_flow

logger = get_logger(__name__)

#: Refusals of a queued send that pass: try again when the next run ends.
_TRANSIENT_STATUSES = (status.HTTP_409_CONFLICT, status.HTTP_429_TOO_MANY_REQUESTS)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def active_run_id(db: AsyncSession, conversation_id: str) -> Optional[str]:
    """The conversation's active run (queued / running / cancelling), if any."""
    return await db.scalar(
        select(MessageTable.id)
        .where(
            MessageTable.conversation_id == conversation_id,
            MessageTable.streaming_status.in_(ACTIVE_RUN_STATUSES),
        )
        .limit(1)
    )


async def _owned_chat(db: AsyncSession, user_id: str, conversation_id: str) -> ConversationTable:
    """The caller's ordinary conversation (never a "Try it" trial), else 404."""
    conversation = (
        await db.execute(
            select(ConversationTable).where(
                ConversationTable.id == conversation_id,
                ConversationTable.user_id == user_id,
                ConversationTable.is_trial.is_(False),
            )
        )
    ).scalar_one_or_none()
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")
    return conversation


async def queue_if_busy(
    db: AsyncSession, user: UserTable, payload: InferenceStartPayload
) -> Optional[QueuedStartResponse]:
    """Hold ``payload`` as the conversation's queued message when it is busy.

    Returns None when the start should go ahead as usual: the flag is off, it
    is not a ``send``, or no run is active. Validated now, not when it is sent,
    so a message that could never run is refused at once: the agent must be
    one the user may use, the command one the agent has.
    """
    if not payload.queue_if_busy or payload.mode != "send" or not payload.conversationId:
        return None
    conversation = await _owned_chat(db, user.id, payload.conversationId)
    running = await active_run_id(db, conversation.id)
    if running is None:
        return None
    message = payload.message
    if message is None or message.sender != "user":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="message is required for this inference mode.")
    if message.attachments:
        # Bytes are never parked in a JSON column; the composer keeps them.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conversation already has an active inference run. Files can be sent once it finishes.",
        )
    agent = await get_agent_by_id(payload.agentId) if payload.agentId else None
    if agent is None or (agent.owner_user_id is not None and agent.owner_user_id != user.id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown or inactive agent.")
    if message.command is not None:
        await check_invocation(db, user.id, agent, message.command)

    queued = QueuedMessageOut(
        content=message.content,
        command=message.command,
        agent_id=agent.id,
        queued_at=_now(),
    )
    # after_run_id: the run this message waits for — it is sent on the leaf
    # that run produces. Internal; never part of the wire shape.
    conversation.queued_message = {**queued.model_dump(mode="json"), "after_run_id": running}
    await db.commit()
    logger.info("composer_message_queued", "Message queued behind the active run",
                conversation_id=conversation.id, run_id=running)
    await publish_queue(conversation.id, queued)

    # The run may have ended between the check and the commit, its run-end
    # hook finding nothing queued yet: then this is the moment to send it.
    if await active_run_id(db, conversation.id) is None:
        await send_queued_message(conversation.id, after_run_id=running, session_factory=_session_factory_of(db))
    return QueuedStartResponse(queued_message=queued)


def _session_factory_of(db: AsyncSession) -> Callable[[], AsyncSession]:
    """A factory for new sessions on the same database as ``db``."""
    bind = db.bind

    def factory() -> AsyncSession:
        return AsyncSession(bind=bind, expire_on_commit=False)

    return factory


async def cancel_queued_message(db: AsyncSession, user_id: str, conversation_id: str) -> None:
    """``DELETE …/queued-message``: drop the slot (a no-op when it is empty)."""
    conversation = await _owned_chat(db, user_id, conversation_id)
    had_one = conversation.queued_message is not None
    conversation.queued_message = None
    await db.commit()
    if had_one:
        logger.info("composer_message_unqueued", "Queued message cancelled", conversation_id=conversation_id)
    await publish_queue(conversation_id, None)


async def _claim(db: AsyncSession, conversation_id: str) -> Optional[tuple[str, dict[str, Any]]]:
    """Take the queued message out of its slot: (user id, message), or None.

    The row is locked while it is read and emptied, so of two racing senders
    exactly one gets the message, and a newer message written meanwhile is
    never emptied by a sender holding an older one.
    """
    row = (
        await db.execute(
            select(ConversationTable.user_id, ConversationTable.queued_message)
            .where(ConversationTable.id == conversation_id)
            .with_for_update()
        )
    ).first()
    if row is None or not isinstance(row.queued_message, dict):
        await db.rollback()
        return None
    await db.execute(
        update(ConversationTable).where(ConversationTable.id == conversation_id).values(queued_message=None)
    )
    await db.commit()
    return row.user_id, row.queued_message


async def _restore(db: AsyncSession, conversation_id: str, value: dict[str, Any]) -> bool:
    """Put a claimed message back, unless a newer one has taken the slot."""
    result = await db.execute(
        update(ConversationTable)
        .where(ConversationTable.id == conversation_id, ConversationTable.queued_message.is_(None))
        .values(queued_message=value)
    )
    await db.commit()
    return bool(result.rowcount)


async def _parent_for(db: AsyncSession, conversation_id: str, after_run_id: Optional[str]) -> Optional[str]:
    """The leaf the queued message continues: the run it waited for, if it is
    this conversation's and has ended; else the conversation's newest message."""
    if after_run_id:
        run = await db.get(MessageTable, after_run_id)
        if (
            run is not None
            and run.conversation_id == conversation_id
            and run.streaming_status not in ACTIVE_RUN_STATUSES
        ):
            return run.id
    return await db.scalar(
        select(MessageTable.id)
        .where(MessageTable.conversation_id == conversation_id)
        .order_by(MessageTable.created_at.desc(), MessageTable.id.desc())
        .limit(1)
    )


async def send_queued_message(
    conversation_id: str,
    *,
    after_run_id: Optional[str] = None,
    session_factory: Optional[Callable[[], AsyncSession]] = None,
) -> bool:
    """Send the conversation's queued message now, as a normal ``send``.

    Returns True when a run was started. Called when a run ends (the run-end
    hook), by the reconcile loop, and by the queue route when the run it was
    queued behind ended in the meantime.
    """
    async with (session_factory or SessionLocal)() as db:
        taken = await _claim(db, conversation_id)
        if taken is None:
            return False
        user_id, value = taken
        queued = queued_message_from_column(value)
        if queued is None:
            logger.warning("composer_queue_invalid", "Dropped an unreadable queued message",
                           conversation_id=conversation_id)
            await publish_queue(conversation_id, None)
            return False
        user = await db.get(UserTable, user_id)
        parent_id = await _parent_for(db, conversation_id, value.get("after_run_id") or after_run_id)
        if user is None or parent_id is None:
            await publish_queue(conversation_id, None)
            return False
        payload = InferenceStartPayload(
            mode="send",
            agentId=queued.agent_id,
            conversationId=conversation_id,
            parentMessageId=parent_id,
            message=MessageIn(sender="user", content=queued.content, command=queued.command),
        )
        try:
            response = await start_inference_flow(db=db, user=user, payload=payload)
        except HTTPException as exc:
            await db.rollback()
            if exc.status_code in _TRANSIENT_STATUSES and await _restore(db, conversation_id, value):
                logger.info("composer_queue_deferred", "Queued message waits for the next run end",
                            conversation_id=conversation_id, status_code=exc.status_code)
                return False
            logger.warning("composer_queue_dropped", "Queued message could not be sent and was dropped",
                           conversation_id=conversation_id, status_code=exc.status_code)
            await publish_queue(conversation_id, None)
            return False
    inference_run_manager.launch(response.run.id)
    logger.info("composer_queue_sent", "Queued message sent", conversation_id=conversation_id,
                run_id=response.run.id)
    await publish_queue(conversation_id, None)
    await publish_run_started(response.run, from_queue=True)
    return True


async def pending_queue_conversations(
    db: AsyncSession, *, older_than_seconds: int, limit: int = 100
) -> list[str]:
    """Conversations holding a queued message and no active run — what a
    restart or a missed run-end left behind (the reconcile loop sends them)."""
    rows = (
        await db.execute(
            select(ConversationTable.id, ConversationTable.queued_message)
            .where(ConversationTable.queued_message.is_not(None))
            .limit(limit)
        )
    ).all()
    cutoff = _now() - timedelta(seconds=older_than_seconds)
    due: list[str] = []
    for conversation_id, value in rows:
        queued = queued_message_from_column(value)
        queued_at = queued.queued_at if queued is not None else None
        if queued_at is not None:
            if queued_at.tzinfo is not None:
                queued_at = queued_at.astimezone(timezone.utc).replace(tzinfo=None)
            if queued_at > cutoff:
                continue  # just queued: its run-end hook will send it
        if await active_run_id(db, conversation_id) is None:
            due.append(conversation_id)
    return due
