from langchain_openai import ChatOpenAI

from .. import config

resoning_llm_1 = ChatOpenAI(model=config.OPENAI_REASONING_LLM_1)

resoning_llm_2 = ChatOpenAI(model=config.OPENAI_REASONING_LLM_2)

resoning_llm_3 = ChatOpenAI(model=config.OPENAI_REASONING_LLM_3)

llm_1 = ChatOpenAI(model=config.OPENAI_LLM)





