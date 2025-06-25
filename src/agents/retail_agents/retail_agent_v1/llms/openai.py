from langchain_openai import ChatOpenAI

from retail_agents.retail_agent_v1.config import (
    OPENAI_LLM_1,
    OPENAI_LLM_2,
    OPENAI_LLM_3,
    OPENAI_REASONING_LLM_1,
    OPENAI_REASONING_LLM_2,
    OPENAI_REASONING_LLM_3
)

reasoning_llm_1 = ChatOpenAI(model=OPENAI_REASONING_LLM_1)
reasoning_llm_2 = ChatOpenAI(model=OPENAI_REASONING_LLM_2)
reasoning_llm_3 = ChatOpenAI(model=OPENAI_REASONING_LLM_3)

llm_1 = ChatOpenAI(model=OPENAI_LLM_1)
llm_2 = ChatOpenAI(model=OPENAI_LLM_2)
llm_3 = ChatOpenAI(model=OPENAI_LLM_3)


