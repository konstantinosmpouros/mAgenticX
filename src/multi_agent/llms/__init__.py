from langchain_openai import ChatOpenAI

from .. import config

# ANALYZER LLM 
analyzer_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_LLM_3,
    name=config.AGENT_NAMES['Analyzer']
)

# SUMMARIZER LLM 
summarizer_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_LLM_2,
    name=config.AGENT_NAMES['Summarizer'],
    streaming=True)

# RETRIEVAL LLM 
retrieval_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_LLM_2,
    name=config.AGENT_NAMES['Retrieval'],
)

# REFLECTION LLM 
reflection_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_LLM_1,
    name=config.AGENT_NAMES['Reflection'],
)

# GENERATION LLM 
generation_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_LLM_2,
    name=config.AGENT_NAMES['Generation'],
    streaming=True
)

