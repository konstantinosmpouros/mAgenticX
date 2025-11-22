from fastapi import HTTPException, status
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableLambda

from llms import gpt_4o_titles
from utils import make_merge_with_template
from schemas import TitleRequest, ConversationTitle


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
    try:
        result = await _title_chain.ainvoke(req.user_input)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to generate title: {exc}",
        ) from exc

    if not result.title:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The title model returned an empty response.",
        )
    return result
