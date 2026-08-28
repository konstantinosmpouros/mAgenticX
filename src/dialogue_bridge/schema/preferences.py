"""User preferences + personalization DTOs (personality presets, custom instructions)."""
from typing import Any
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


# Personality presets recognised by the agents service (its registry lives in
# agents `runtime/personalization.py`). Kept in lockstep manually; the agents
# side is fail-closed, so an id it doesn't know collapses to "default" there
# instead of erroring — drift degrades gracefully.
PERSONALITY_IDS = frozenset(
    {"default", "professional", "friendly", "candid", "quirky", "efficient", "cynical", "nerdy"}
)


class CustomInstructions(BaseModel):
    """User-authored custom instructions (Settings → Personalization).

    Injected into deep-agent system prompts while ``enabled`` is true. Length
    caps mirror the agents-side re-validation (defense in depth); control
    characters are stripped here so the stored document is already clean.
    """
    model_config = ConfigDict(populate_by_name=True)

    enabled: bool = False
    nickname: str = Field(default="", max_length=100)
    occupation: str = Field(default="", max_length=150)
    traits: str = Field(default="", max_length=1500)
    about: str = Field(default="", max_length=1500)

    @field_validator("nickname", "occupation", "traits", "about", mode="before")
    @classmethod
    def _sanitize_text(cls, value: Any) -> str:
        """Coerce to a clean string: drop control chars (newlines/tabs survive —
        the long fields are legitimately multi-line) and trim edges. Length is
        enforced by the field caps afterwards, rejecting oversize payloads."""
        if not isinstance(value, str):
            return ""
        return "".join(ch for ch in value if ch in "\n\t" or ord(ch) >= 32).strip()


class UserPreferences(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    suggestionsEnabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("suggestions_enabled", "suggestionsEnabled"),
        serialization_alias="suggestionsEnabled",
    )
    showMessageTokenUsage: bool = Field(
        default=False,
        validation_alias=AliasChoices("show_message_token_usage", "showMessageTokenUsage"),
        serialization_alias="showMessageTokenUsage",
    )
    searchPastConvs: bool = Field(
        default=False,
        validation_alias=AliasChoices("search_past_convs", "searchPastConvs"),
        serialization_alias="searchPastConvs",
    )
    useMemory: bool = Field(
        default=True,
        validation_alias=AliasChoices("use_memory", "useMemory"),
        serialization_alias="useMemory",
    )
    personality: str = Field(default="default")
    customInstructions: CustomInstructions = Field(
        default_factory=CustomInstructions,
        validation_alias=AliasChoices("custom_instructions", "customInstructions"),
        serialization_alias="customInstructions",
    )
    voiceModeVoice: str = Field(
        default="alloy",
        validation_alias=AliasChoices("voice_mode_voice", "voiceModeVoice"),
        serialization_alias="voiceModeVoice",
    )
    voiceModeLanguage: str = Field(
        default="english",
        validation_alias=AliasChoices("voice_mode_language", "voiceModeLanguage"),
        serialization_alias="voiceModeLanguage",
    )

    @field_validator("personality", mode="before")
    @classmethod
    def _normalize_personality(cls, value: Any) -> str:
        """Fail-closed preset validation: anything outside the registry —
        malformed input or a preset removed in a newer deploy — collapses to
        "default" (same stance as voice normalization) instead of erroring."""
        candidate = value.strip().lower() if isinstance(value, str) else ""
        return candidate if candidate in PERSONALITY_IDS else "default"
