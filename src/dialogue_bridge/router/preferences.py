from fastapi import APIRouter, Depends, status
from core.logging import get_logger, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection
from core.database import UserPreferencesTable, get_db
from schemas import UserPreferences
from utils import normalize_realtime_voice, normalize_voice_mode_language, validate_userId


router = APIRouter()
logger = get_logger(__name__)


@router.get("/{user_id}", response_model=UserPreferences, status_code=status.HTTP_200_OK)
async def get_user_preferences(
    user_id: str,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """
    Return generic user preferences (future-proof JSON) scoped to the given user.
    """
    set_context(user_id=user_id)
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    row: UserPreferencesTable | None = result.scalar_one_or_none()
    if row is None:
        logger.info("preferences_defaulted", "No stored user preferences found")
        return UserPreferences()

    payload: dict = {
        "prefers_agentic_chat": bool(row.prefers_agentic_chat),
        "suggestions_enabled": bool(row.suggestions_enabled),
        "show_message_token_usage": bool(row.show_message_token_usage),
        "search_past_convs": bool(row.search_past_convs),
        "use_memory": bool(row.use_memory),
        # Schema-level validators normalize both: unknown personality ids
        # collapse to "default", stored custom-instruction text is re-sanitized.
        "personality": row.personality,
        "custom_instructions": row.custom_instructions if isinstance(row.custom_instructions, dict) else {},
        "voice_mode_voice": normalize_realtime_voice(row.voice_mode_voice),
        "voice_mode_language": normalize_voice_mode_language(row.voice_mode_language),
    }
    logger.info("preferences_loaded", "Loaded user preferences")
    return UserPreferences.model_validate(payload)


@router.put("/{user_id}", response_model=UserPreferences, status_code=status.HTTP_200_OK)
async def upsert_user_preferences(
    user_id: str,
    payload: UserPreferences,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """
    Replace the user's preferences document with the provided payload.
    """
    set_context(user_id=user_id)
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    existing: UserPreferencesTable | None = result.scalar_one_or_none()
    voice_mode_voice = normalize_realtime_voice(payload.voiceModeVoice)
    voice_mode_language = normalize_voice_mode_language(payload.voiceModeLanguage)
    # Already normalized by the schema: personality is fail-closed against the
    # preset registry, custom-instruction text sanitized + length-capped.
    custom_instructions = payload.customInstructions.model_dump(mode="json")
    if existing:
        existing.prefers_agentic_chat = bool(payload.prefersAgenticChat)
        existing.suggestions_enabled = bool(payload.suggestionsEnabled)
        existing.show_message_token_usage = bool(payload.showMessageTokenUsage)
        existing.search_past_convs = bool(payload.searchPastConvs)
        existing.use_memory = bool(payload.useMemory)
        existing.personality = payload.personality
        existing.custom_instructions = custom_instructions
        existing.voice_mode_voice = voice_mode_voice
        existing.voice_mode_language = voice_mode_language
    else:
        db.add(
            UserPreferencesTable(
                user_id=user_id,
                prefers_agentic_chat=bool(payload.prefersAgenticChat),
                suggestions_enabled=bool(payload.suggestionsEnabled),
                show_message_token_usage=bool(payload.showMessageTokenUsage),
                search_past_convs=bool(payload.searchPastConvs),
                use_memory=bool(payload.useMemory),
                personality=payload.personality,
                custom_instructions=custom_instructions,
                voice_mode_voice=voice_mode_voice,
                voice_mode_language=voice_mode_language,
            )
        )

    await db.commit()
    # Custom-instruction content is user PII — log only the enabled flag and
    # the personality preset id, never the text itself.
    logger.info(
        "preferences_updated",
        "Updated user preferences",
        prefers_agentic_chat=bool(payload.prefersAgenticChat),
        suggestions_enabled=bool(payload.suggestionsEnabled),
        personality=payload.personality,
        custom_instructions_enabled=payload.customInstructions.enabled,
        voice_mode_voice=voice_mode_voice,
        voice_mode_language=voice_mode_language,
    )
    return UserPreferences(
        prefersAgenticChat=bool(payload.prefersAgenticChat),
        suggestionsEnabled=bool(payload.suggestionsEnabled),
        showMessageTokenUsage=bool(payload.showMessageTokenUsage),
        searchPastConvs=bool(payload.searchPastConvs),
        useMemory=bool(payload.useMemory),
        personality=payload.personality,
        customInstructions=payload.customInstructions,
        voiceModeVoice=voice_mode_voice,
        voiceModeLanguage=voice_mode_language,
    )
