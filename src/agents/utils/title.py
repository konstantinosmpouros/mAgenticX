from fastapi import HTTPException, status
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableLambda

from llms import gpt_4o_titles
from observability import get_logger
from utils import make_merge_with_template
from schemas import TitleRequest, ConversationTitle

logger = get_logger(__name__)

TITLE_PROMPT_TEMPLATE = ChatPromptTemplate.from_messages([
    ("system", (
        "You write concise, human-readable chat titles suitable for a sidebar list. "
        "Capture the main intent of the provided user message in 3 to 6 words. "
        "Avoid quotation marks, emojis, numbered prefixes, or trailing punctuation. "
        "Try to use common phrases that a user would understand at a glance."
    )),
])


_title_prompt_merge = RunnableLambda(make_merge_with_template(TITLE_PROMPT_TEMPLATE))
_title_chain = _title_prompt_merge | gpt_4o_titles.with_structured_output(ConversationTitle)

async def generate_title(req: TitleRequest) -> ConversationTitle:
    """Generate a short, descriptive title for a new conversation."""
    logger.info("title_generation_started", "Title generation started", prompt_messages=len(req.user_input))
    try:
        result = await _title_chain.ainvoke(req.user_input)
    except Exception as exc:
        logger.warning("title_generation_failed", "Failed to generate conversation title", error=str(exc), failure_reason="model_invoke_failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to generate title: {exc}",
        ) from exc

    if not result.title:
        logger.warning("title_generation_empty", "Title model returned an empty response", failure_reason="empty_title")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The title model returned an empty response.",
        )
    logger.info("title_generation_completed", "Title generation completed", title_length=len(result.title.strip()))
    return result
