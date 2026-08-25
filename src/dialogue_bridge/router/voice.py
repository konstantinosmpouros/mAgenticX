from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from core.logging import get_logger, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.auth.session import AuthUser, require_csrf_protection
from core.security.rate_limit import voice_session_rate_limit
from core.database import AttachmentTable, ConversationTable, MessageTable, get_db
from core.settings import settings
from schemas import (
    ConversationSummary,
    MessageIn,
    MessageOut,
    RealtimeVoiceConversationEventIn,
    RealtimeVoiceEndIn,
    RealtimeVoiceEndOut,
    RealtimeVoiceSessionIn,
    RealtimeVoiceSessionOut,
    UpdateConversationResponse,
)
from utils import (
    _preview,
    build_voice_instructions,
    create_realtime_session_with_agents,
    init_message,
    load_owned_voice_conversation,
    load_realtime_agent,
    preferred_realtime_voice,
    preferred_voice_mode_language,
    validate_userId,
)


router = APIRouter()
logger = get_logger(__name__)


@router.post(
    "/realtime/{user_id}/session",
    response_model=RealtimeVoiceSessionOut,
    status_code=status.HTTP_200_OK,
    summary="Create a realtime voice WebRTC session",
    # Opens a paid OpenAI Realtime session — strict per-user ceiling.
    dependencies=[Depends(voice_session_rate_limit)],
)
async def createRealtimeVoiceSession(
    user_id: str,
    payload: RealtimeVoiceSessionIn,
    _current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> RealtimeVoiceSessionOut:
    set_context(user_id=user_id, conversation_id=payload.conversationId)
    agent = await load_realtime_agent(db, payload.agentId)
    conversation = await load_owned_voice_conversation(db, user_id, payload.conversationId) if payload.conversationId else None

    if conversation and conversation.agent_id != agent.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Selected agent does not match this conversation.")

    voice = await preferred_realtime_voice(db, user_id, payload.voice)
    language = await preferred_voice_mode_language(db, user_id, payload.language)
    model = settings.voice.realtime_model
    upstream = await create_realtime_session_with_agents(
        sdp=payload.sdp,
        model=model,
        voice=voice,
        instructions=build_voice_instructions(agent, conversation, language),
        metadata={
            "user_id": user_id,
            "conversation_id": conversation.id if conversation else None,
            "agent_id": agent.id,
            "voice_mode_language": language,
        },
    )
    logger.info("realtime_voice_session_created", "Realtime voice session created", conversation_id=conversation.id if conversation else None, agent_id=agent.id, model=model, voice=voice, voice_mode_language=language)
    return RealtimeVoiceSessionOut(
        sdp=upstream["sdp"],
        model=str(upstream.get("model") or model),
        voice=str(upstream.get("voice") or voice),
    )


@router.post(
    "/realtime/{user_id}/conversation-event",
    response_model=UpdateConversationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Persist a realtime voice transcript turn",
)
async def persistRealtimeVoiceConversationEvent(
    user_id: str,
    payload: RealtimeVoiceConversationEventIn,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> UpdateConversationResponse:
    set_context(user_id=user_id, conversation_id=payload.conversationId)
    conversation = await load_owned_voice_conversation(db, user_id, payload.conversationId)
    transcript = payload.transcript.strip()
    if not transcript:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript cannot be empty.")

    parent_message_id = conversation.messages[-1].id if conversation.messages else None
    message_payload = MessageIn(
        sender="user" if payload.role == "user" else "ai",
        type="audio",
        content=transcript,
        parentMessageId=parent_message_id,
        rawEvents=[payload.rawEvent] if payload.rawEvent else [],
    )
    message = await init_message(db, conversation, message_payload, parent_message_id=parent_message_id)
    conversation.last_message_preview = _preview(transcript)
    conversation.last_message_at = datetime.now()
    await db.commit()

    stmt = (
        select(MessageTable)
        .options(selectinload(MessageTable.attachments).selectinload(AttachmentTable.blob))
        .where(MessageTable.id == message.id)
    )
    result = await db.execute(stmt)
    message_row = result.scalar_one()
    await db.refresh(conversation, attribute_names=["updated_at", "last_message_preview", "agent"])
    logger.info(
        "realtime_voice_transcript_persisted",
        "Realtime voice transcript persisted",
        message_id=message.id,
        role=payload.role,
        transcript_length=len(transcript),
    )
    return UpdateConversationResponse(
        message=MessageOut.model_validate(message_row),
        summary=ConversationSummary.model_validate(conversation),
    )


@router.post(
    "/realtime/{user_id}/end",
    response_model=RealtimeVoiceEndOut,
    status_code=status.HTTP_200_OK,
    summary="Finalize a realtime voice session",
)
async def endRealtimeVoiceSession(
    user_id: str,
    payload: RealtimeVoiceEndIn,
    _current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> RealtimeVoiceEndOut:
    set_context(user_id=user_id, conversation_id=payload.conversationId)
    conversation = await load_owned_voice_conversation(db, user_id, payload.conversationId)
    await db.refresh(conversation, attribute_names=["updated_at", "last_message_preview", "agent"])
    logger.info("realtime_voice_session_ended", "Realtime voice session ended", conversation_id=conversation.id)
    return RealtimeVoiceEndOut(summary=ConversationSummary.model_validate(conversation))
