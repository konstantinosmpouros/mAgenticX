from fastapi import HTTPException, status
from langchain.chat_models import init_chat_model
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableLambda

from core.configs import configs
from core.error_handling import provider_error_handler
from observability import get_logger
from schemas import ConversationSuggestions, SuggestionsRequest
from utils import make_merge_with_template

logger = get_logger(__name__)

_SUGGESTION_COUNT = 10
_SUGGESTION_MAX_LEN = 160

SUGGESTIONS_PROMPT_TEMPLATE = ChatPromptTemplate.from_messages([
    ("system", (
        "You generate short, useful starter suggestions for a chat composer. "
        "Return exactly 10 distinct suggestions as a JSON list in the `suggestions` field. "
        "Use the supplied recent conversation context and selected agent context when available. "
        "Each suggestion must be a direct user prompt, one sentence, practical, and no longer than 16 words. "
        "Avoid numbered prefixes, quotation marks, emojis, markdown, sensitive personal data, and duplicate intent."
    )),
])


_suggestions_prompt_merge = RunnableLambda(make_merge_with_template(SUGGESTIONS_PROMPT_TEMPLATE))
_suggestions_chain = _suggestions_prompt_merge | init_chat_model(
    configs.runtime_models.suggestions,
    temperature=0.8,
    max_tokens=320,
).with_structured_output(ConversationSuggestions)


def _normalize_suggestions(raw_suggestions: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()

    for raw_suggestion in raw_suggestions or []:
        suggestion = (raw_suggestion or "").strip().strip("-").strip()
        if not suggestion:
            continue
        if len(suggestion) > _SUGGESTION_MAX_LEN:
            suggestion = suggestion[:_SUGGESTION_MAX_LEN].rstrip()
        key = suggestion.casefold()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(suggestion)
        if len(cleaned) == _SUGGESTION_COUNT:
            break

    return cleaned


async def generate_suggestions(req: SuggestionsRequest) -> ConversationSuggestions:
    """Generate personalized starter suggestions for a new conversation."""
    logger.info("suggestion_generation_started", "Suggestion generation started", prompt_messages=len(req.user_input))
    try:
        result = await _suggestions_chain.ainvoke(req.user_input)
    except Exception as exc:
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="suggestion_generation_failed",
            message="Failed to generate suggestions",
            public_detail="Suggestion generation is temporarily unavailable. Please try again.",
            provider="model",
            operation="generate_suggestions",
            model=configs.runtime_models.suggestions,
        )

    suggestions = _normalize_suggestions(result.suggestions)
    if len(suggestions) < _SUGGESTION_COUNT:
        logger.warning(
            "suggestion_generation_invalid_candidates",
            "Suggestion model returned too few usable candidates",
            candidate_count=len(suggestions),
            raw_candidate_count=len(result.suggestions or []),
            failure_reason="insufficient_candidates",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Suggestion generation returned an invalid response. Please try again.",
        )

    logger.info(
        "suggestion_generation_completed",
        "Suggestion generation completed",
        candidate_count=len(suggestions),
        truncated_or_deduped=len(suggestions) != len(result.suggestions or []),
    )
    return ConversationSuggestions(suggestions=suggestions)
