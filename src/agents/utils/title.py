from fastapi import HTTPException, status
from langchain.chat_models import init_chat_model
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableLambda

from core.configs import configs
from observability import get_logger
from utils import make_merge_with_template
from schemas import TitleRequest, ConversationTitle

logger = get_logger(__name__)
_TITLE_CANDIDATE_COUNT = 4
_TITLE_MIN_CANDIDATES = 3
_TITLE_MAX_LEN = 120

TITLE_PROMPT_TEMPLATE = ChatPromptTemplate.from_messages([
    ("system", (
        "You write concise, human-readable chat titles suitable for a sidebar list. "
        "Return exactly 4 distinct title options for the provided user message as a JSON list in the `titles` field. "
        "Each title should capture the main intent in 3 to 5 words. "
        "Avoid quotation marks, emojis, numbered prefixes, and trailing punctuation. "
        "Use common phrases that a user would understand at a glance."
    )),
])


_title_prompt_merge = RunnableLambda(make_merge_with_template(TITLE_PROMPT_TEMPLATE))
_title_chain = _title_prompt_merge | init_chat_model(
    configs.runtime_models.title,
    temperature=1,
    max_tokens=128,
).with_structured_output(ConversationTitle)


def _normalize_title_candidates(raw_titles: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()

    for raw_title in raw_titles or []:
        title = (raw_title or "").strip()
        if not title:
            continue
        if len(title) > _TITLE_MAX_LEN:
            title = title[:_TITLE_MAX_LEN].rstrip()
        key = title.casefold()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(title)
        if len(cleaned) == _TITLE_CANDIDATE_COUNT:
            break

    return cleaned

async def generate_title(req: TitleRequest) -> ConversationTitle:
    """Generate multiple short, descriptive title options for a new conversation."""
    logger.info("title_generation_started", "Title generation started", prompt_messages=len(req.user_input))
    try:
        result = await _title_chain.ainvoke(req.user_input)
    except Exception as exc:
        logger.warning("title_generation_failed", "Failed to generate conversation title", error=str(exc), failure_reason="model_invoke_failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to generate title: {exc}",
        ) from exc

    titles = _normalize_title_candidates(result.titles)
    if len(titles) < _TITLE_MIN_CANDIDATES:
        logger.warning(
            "title_generation_invalid_candidates",
            "Title model returned too few usable title candidates",
            candidate_count=len(titles),
            raw_candidate_count=len(result.titles or []),
            failure_reason="insufficient_candidates",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The title model returned too few usable title candidates.",
        )
    logger.info(
        "title_generation_completed",
        "Title generation completed",
        candidate_count=len(titles),
        truncated_or_deduped=len(titles) != len(result.titles or []),
    )
    return ConversationTitle(titles=titles)
