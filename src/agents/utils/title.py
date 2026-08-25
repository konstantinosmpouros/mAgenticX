from fastapi import HTTPException, status
from langchain.chat_models import init_chat_model
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableLambda

from core.settings import settings
from core.error_handling import provider_error_handler
from core.logging import get_logger
from utils import make_merge_with_template
from schemas import TitleRequest, ConversationTitle

logger = get_logger(__name__)

TITLE_PROMPT_TEMPLATE = ChatPromptTemplate.from_messages([
    ("system", (
        "You write concise, human-readable chat titles suitable for a sidebar list. "
        f"Return exactly {settings.generation.title_candidate_count} distinct title options for the provided user message as a JSON list in the `titles` field. "
        "Each title should capture the main intent in 3 to 5 words. "
        "Avoid quotation marks, emojis, numbered prefixes, and trailing punctuation. "
        "Use common phrases that a user would understand at a glance."
    )),
])


_title_prompt_merge = RunnableLambda(make_merge_with_template(TITLE_PROMPT_TEMPLATE))
_title_chain = _title_prompt_merge | init_chat_model(
    settings.runtime_models.title,
    temperature=settings.generation.title_temperature,
    max_tokens=settings.generation.title_max_tokens,
).with_structured_output(ConversationTitle)


def _normalize_title_candidates(raw_titles: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()

    for raw_title in raw_titles or []:
        title = (raw_title or "").strip()
        if not title:
            continue
        if len(title) > settings.generation.title_max_len:
            title = title[:settings.generation.title_max_len].rstrip()
        key = title.casefold()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(title)
        if len(cleaned) == settings.generation.title_candidate_count:
            break

    return cleaned

async def generate_title(req: TitleRequest) -> ConversationTitle:
    """Generate multiple short, descriptive title options for a new conversation."""
    logger.info("title_generation_started", "Title generation started", prompt_messages=len(req.user_input))
    try:
        result = await _title_chain.ainvoke(req.user_input)
    except Exception as exc:
        provider_error_handler.raise_provider_error(
            logger,
            exc,
            event="title_generation_failed",
            message="Failed to generate conversation title",
            public_detail="Title generation is temporarily unavailable. Please try again.",
            provider="model",
            operation="generate_title",
            model=settings.runtime_models.title,
        )

    titles = _normalize_title_candidates(result.titles)
    if len(titles) < settings.generation.title_min_candidates:
        logger.warning(
            "title_generation_invalid_candidates",
            "Title model returned too few usable title candidates",
            candidate_count=len(titles),
            raw_candidate_count=len(result.titles or []),
            failure_reason="insufficient_candidates",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Title generation returned an invalid response. Please try again.",
        )
    logger.info(
        "title_generation_completed",
        "Title generation completed",
        candidate_count=len(titles),
        truncated_or_deduped=len(titles) != len(result.titles or []),
    )
    return ConversationTitle(titles=titles)
