from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import AttachmentTable, MessageTable
from schema import MessageUpdate


async def get_owned_message(
    db: AsyncSession,
    conversation_id: str,
    message_id: str,
    *,
    with_attachments: bool = True,
) -> MessageTable | None:
    """Load a single message scoped to its conversation, optionally eager-loading attachment blobs."""
    stmt = select(MessageTable).where(
        MessageTable.id == message_id,
        MessageTable.conversation_id == conversation_id,
    )
    if with_attachments:
        stmt = stmt.options(
            selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob)
        )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


def apply_ai_message_update(message: MessageTable, payload: MessageUpdate) -> None:
    """Apply a streaming-finalization payload onto an AI message row in place."""
    message.content = payload.content
    message.reasoning_steps = payload.thinking
    message.reasoning_time_seconds = payload.thinkingTime
    if payload.error is not None:
        message.is_error = bool(payload.error)
    message.error_message = payload.errorMessage
    message.raw_events = payload.rawEvents


def toggle_message_reaction(message: MessageTable, reaction: bool) -> None:
    """Toggle a like (reaction=True) or dislike (reaction=False); re-clicking clears it."""
    message.liked = None if message.liked is reaction else reaction
