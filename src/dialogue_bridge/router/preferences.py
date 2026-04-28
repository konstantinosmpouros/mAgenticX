from fastapi import APIRouter, Depends, status
from observability import get_logger, set_context
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth_session import require_csrf_protection
from core.database import UserPreferencesTable, UserTable, get_db
from schemas import UserPreferences
from utils import normalize_read_aloud_voice, validate_userId


router = APIRouter()
logger = get_logger(__name__)


@router.get("/{user_id}", response_model=UserPreferences, status_code=status.HTTP_200_OK)
async def get_user_preferences(
    user_id: str,
    _: UserTable = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """
    Return generic user preferences (future-proof JSON) scoped to the given user.
    Currently supports tools.disabled list.
    """
    set_context(user_id=user_id)
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    row: UserPreferencesTable | None = result.scalar_one_or_none()
    if row is None:
        logger.info("preferences_defaulted", "No stored user preferences found")
        return UserPreferences()

    payload: dict = {
        "tools": row.tools if isinstance(row.tools, dict) else {},
        "prefers_agentic_chat": bool(row.prefers_agentic_chat),
        "suggestions_enabled": bool(row.suggestions_enabled),
        "read_aloud_voice": normalize_read_aloud_voice(row.read_aloud_voice),
    }
    logger.info("preferences_loaded", "Loaded user preferences")
    return UserPreferences.model_validate(payload)


@router.put("/{user_id}", response_model=UserPreferences, status_code=status.HTTP_200_OK)
async def upsert_user_preferences(
    user_id: str,
    payload: UserPreferences,
    _: UserTable = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """
    Replace the user's preferences document with the provided payload.
    """
    set_context(user_id=user_id)
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    existing: UserPreferencesTable | None = result.scalar_one_or_none()
    read_aloud_voice = normalize_read_aloud_voice(payload.readAloudVoice)
    if existing:
        existing.tools = payload.tools.model_dump(mode="json", by_alias=True)
        existing.prefers_agentic_chat = bool(payload.prefersAgenticChat)
        existing.suggestions_enabled = bool(payload.suggestionsEnabled)
        existing.read_aloud_voice = read_aloud_voice
    else:
        db.add(
            UserPreferencesTable(
                user_id=user_id,
                tools=payload.tools.model_dump(mode="json", by_alias=True),
                prefers_agentic_chat=bool(payload.prefersAgenticChat),
                suggestions_enabled=bool(payload.suggestionsEnabled),
                read_aloud_voice=read_aloud_voice,
            )
        )

    await db.commit()
    logger.info("preferences_updated", "Updated user preferences", disabled_tools=len(payload.tools.disabled), prefers_agentic_chat=bool(payload.prefersAgenticChat), suggestions_enabled=bool(payload.suggestionsEnabled), read_aloud_voice=read_aloud_voice)
    return UserPreferences(
        tools=payload.tools,
        prefersAgenticChat=bool(payload.prefersAgenticChat),
        suggestionsEnabled=bool(payload.suggestionsEnabled),
        readAloudVoice=read_aloud_voice,
    )
