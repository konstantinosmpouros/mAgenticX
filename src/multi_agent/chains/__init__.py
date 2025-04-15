from langchain_openai import ChatOpenAI

from .structured_outputs import (
    AnalyzerOutput,
    RetrievalQueriesOutput,
    ReflectionOutput
)

from .. import config
from ..tools import financial_tools, search_tools

from ..prompt_templates import (
    analyzer_template,
    reflection_template,
    retrieval_template,
    summarizer_template,
    generation_template
)

# ANALYZER CHAIN 
analyzer_llm = ChatOpenAI(
    model=config.OPENAI_LLM_NAME,
    name=config.AGENT_NAMES['Analyzer']
).with_structured_output(AnalyzerOutput)
analyzer_chain = analyzer_template | analyzer_llm


# SUMMARIZER CHAIN 
summarizer_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_MODEL_NAME2,
    name=config.AGENT_NAMES['Summarizer'],
    streaming=True)
summarizer_chain = summarizer_template | summarizer_llm


# RETRIEVAL CHAIN 
retrieval_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_MODEL_NAME2,
    name=config.AGENT_NAMES['Retrieval'],
).with_structured_output(RetrievalQueriesOutput)
retrieval_chain = retrieval_template | retrieval_llm


# REFLECTION CHAIN 
reflection_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_MODEL_NAME1,
    name=config.AGENT_NAMES['Reflection'],
).with_structured_output(ReflectionOutput)
reflection_chain = reflection_template | reflection_llm


# GENERATION CHAIN 
generation_llm = ChatOpenAI(
    model=config.OPENAI_REASONING_MODEL_NAME2,
    name=config.AGENT_NAMES['Generation'],
    streaming=True)
generation_chain = generation_template | generation_llm

