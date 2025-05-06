from langchain_anthropic import ChatAnthropic

from ..config import (
    ANTHROPIC_LLM_1,
    ANTHROPIC_LLM_2,
    ANTHROPIC_REASONING_LLM_1
)

reasoning_llm_1 = ChatAnthropic(model=ANTHROPIC_REASONING_LLM_1)

llm_1 = ChatAnthropic(model=ANTHROPIC_LLM_1)
llm_2 = ChatAnthropic(model=ANTHROPIC_LLM_2)





