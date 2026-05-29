from datetime import datetime
from typing import cast

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import AttachmentTable, ConversationTable, InferenceRunTable, MessageTable, UserTable
from schemas import (
    ConversationDetail,
    ConversationSummary,
    InferenceRunOut,
    InferenceStartPayload,
    InferenceStartResponse,
    MessageIn,
    MessageOut,
)
from utils.agents import get_agent_by_id
from utils.conversations import _preview, init_conv, init_message
from utils.inference import resolve_inference_message_path
from utils.inference_runs import create_inference_run_record
from utils.shared_conv import create_conversation_from_share_record, load_active_share
from utils.titles import resolve_conversation_title
from utils.validators import validate_convId_full


def _require_message(payload: InferenceStartPayload) -> MessageIn:
    if payload.message is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="message is required for this inference mode.")
    if payload.message.sender != "user":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Inference start messages must be user messages.")
    return payload.message


def _message_by_id(messages: list[MessageTable], message_id: str, *, detail: str = "Message not found.") -> MessageTable:
    match = next((message for message in messages if message.id == message_id), None)
    if not match:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)
    return match


async def _load_message(db: AsyncSession, message_id: str) -> MessageTable | None:
    result = await db.execute(
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(MessageTable.id == message_id)
    )
    return result.scalar_one_or_none()


async def _load_run(db: AsyncSession, run_id: str) -> InferenceRunTable | None:
    result = await db.execute(select(InferenceRunTable).where(InferenceRunTable.id == run_id))
    return result.scalar_one_or_none()


async def start_inference_flow(
    *,
    db: AsyncSession,
    user: UserTable,
    payload: InferenceStartPayload,
) -> InferenceStartResponse:
    user_id = user.id
    mode = payload.mode
    if mode == "new":
        conversation, parent_message_id = await _create_new_conversation_start(db, user, payload)
    elif mode == "send":
        conversation, parent_message_id = await _append_user_message_start(db, user_id, payload)
    elif mode == "edit":
        conversation, parent_message_id = await _create_edit_branch_start(db, user_id, payload)
    elif mode == "retry":
        conversation, parent_message_id = await _create_retry_start(db, user_id, payload)
    elif mode == "shared_continue":
        conversation, parent_message_id = await _create_shared_continue_start(db, user, payload)
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported inference start mode.")

    # For new/send/edit/shared_continue the backend creates the run parent inside this request,
    # so any client path necessarily ends before the real parent. Retry is the
    # only start mode where the client can provide a path ending at the run parent.
    message_path = payload.messagePath if mode == "retry" else None
    run, assistant_message = await create_inference_run_record(
        db=db,
        user_id=user_id,
        conversation=conversation,
        parent_message_id=parent_message_id,
        message_path=message_path,
        enabled_tools=payload.enabledTools,
    )
    conversation_id = conversation.id
    run_id = run.id
    assistant_message_id = assistant_message.id
    await db.commit()
    db.expire_all()

    detail = await validate_convId_full(user_id, conversation_id, db)
    loaded_run = await _load_run(db, run_id)
    loaded_message = await _load_message(db, assistant_message_id)
    if loaded_run is None or loaded_message is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Inference run start could not be loaded after creation.")

    return InferenceStartResponse(
        detail=ConversationDetail.model_validate(detail),
        summary=ConversationSummary.model_validate(detail),
        run=InferenceRunOut.model_validate(loaded_run),
        message=MessageOut.model_validate(loaded_message),
    )


async def _create_new_conversation_start(
    db: AsyncSession,
    user: UserTable,
    payload: InferenceStartPayload,
) -> tuple[ConversationTable, str]:
    if not payload.agentId:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="agentId is required for new inference starts.")
    first_message = _require_message(payload)
    agent = await get_agent_by_id(payload.agentId)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown or inactive agent.")

    title = await resolve_conversation_title(
        first_message=first_message,
        explicit_title=payload.title,
        agent_name=agent.name,
        agent_id=agent.id,
    )
    conversation = await init_conv(
        db=db,
        user=user,
        agent=agent,
        is_private=payload.isPrivate,
        title=title,
        first_message=first_message,
    )
    await db.flush()
    db.expire(conversation, ["messages"])
    conversation = await validate_convId_full(user.id, conversation.id, db)
    first = conversation.messages[-1] if conversation.messages else None
    if first is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Conversation first message was not created.")
    return conversation, first.id


async def _append_user_message_start(
    db: AsyncSession,
    user_id: str,
    payload: InferenceStartPayload,
) -> tuple[ConversationTable, str]:
    if not payload.conversationId:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="conversationId is required for send inference starts.")
    if not payload.parentMessageId:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="parentMessageId is required for send inference starts.")
    message = _require_message(payload)
    conversation = await validate_convId_full(user_id, payload.conversationId, db)
    _message_by_id(conversation.messages, payload.parentMessageId, detail="Parent message does not belong to this conversation.")
    resolve_inference_message_path(conversation.messages, payload.parentMessageId, payload.messagePath)
    created = await init_message(db, conversation, message, parent_message_id=payload.parentMessageId)
    _touch_conversation_from_user_message(conversation, message)
    await db.flush()
    db.expire(conversation, ["messages"])
    conversation = await validate_convId_full(user_id, conversation.id, db)
    return conversation, created.id


async def _create_edit_branch_start(
    db: AsyncSession,
    user_id: str,
    payload: InferenceStartPayload,
) -> tuple[ConversationTable, str]:
    if not payload.conversationId or not payload.targetMessageId:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="conversationId and targetMessageId are required for edit inference starts.")
    message = _require_message(payload)
    conversation = await validate_convId_full(user_id, payload.conversationId, db)
    target = _message_by_id(conversation.messages, payload.targetMessageId, detail="Edited message does not belong to this conversation.")
    if target.sender != "user":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only user messages can be edited into a new inference branch.")
    created = await init_message(db, conversation, message, parent_message_id=target.parent_message_id)
    _touch_conversation_from_user_message(conversation, message)
    await db.flush()
    db.expire(conversation, ["messages"])
    conversation = await validate_convId_full(user_id, conversation.id, db)
    return conversation, created.id


async def _create_retry_start(
    db: AsyncSession,
    user_id: str,
    payload: InferenceStartPayload,
) -> tuple[ConversationTable, str]:
    if not payload.conversationId or not payload.targetMessageId:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="conversationId and targetMessageId are required for retry inference starts.")
    conversation = await validate_convId_full(user_id, payload.conversationId, db)
    target = _message_by_id(conversation.messages, payload.targetMessageId, detail="Retry target does not belong to this conversation.")
    if target.sender != "ai":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only AI messages can be retried.")
    parent_message_id = cast(str | None, target.parent_message_id)
    if not parent_message_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Retry target is missing a parent prompt.")
    _message_by_id(conversation.messages, parent_message_id, detail="Retry parent message does not belong to this conversation.")
    return conversation, parent_message_id


async def _create_shared_continue_start(
    db: AsyncSession,
    user: UserTable,
    payload: InferenceStartPayload,
) -> tuple[ConversationTable, str]:
    if not payload.sharedConversationToken:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="sharedConversationToken is required for shared conversation inference starts.")
    message = _require_message(payload)
    share = await load_active_share(payload.sharedConversationToken, db)
    return await create_conversation_from_share_record(
        db=db,
        share=share,
        current_user=user,
        first_message=message,
    )


def _touch_conversation_from_user_message(conversation: ConversationTable, message: MessageIn) -> None:
    preview = _preview(message.content) or (message.attachments[0].name if message.attachments else None)
    if preview is not None:
        conversation.last_message_preview = preview
        conversation.last_message_at = datetime.now()
