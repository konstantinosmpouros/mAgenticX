from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

# OpenAI LLMs & agents
from llms.openai import reasoning_llm_1, reasoning_llm_2
from agents.templates.prebuilt import react_agent

# Structured Outputs
from llms.structured_outputs.orthodoxai_v1 import AnalyzerOutput, ReflectionOutput, RetrievalQueriesOutput

# Tools
from tools import (
    financial_tools,
    search_tools,
    articles_tools,
    computer_vision_tools
)
tools = financial_tools + search_tools + articles_tools + computer_vision_tools

# Prompt Template
from prompts.templates.orthodoxai_v1 import (
    analyzer_template,
    summarization_template,
    reflection_template,
    query_gen_no_reflection_template,
    query_gen_with_reflection_template
)


# ---------------------------------------------------------------------------------------------------
# OrthodoxAI v1
# ---------------------------------------------------------------------------------------------------
analysis_agent = analyzer_template | reasoning_llm_2.with_structured_output(AnalyzerOutput)

simple_gen_agent = react_agent(model=reasoning_llm_2, tools=tools)

query_reflective_agent = query_gen_with_reflection_template | reasoning_llm_2.with_structured_output(RetrievalQueriesOutput)
query_no_reflective_agent = query_gen_no_reflection_template | reasoning_llm_2.with_structured_output(RetrievalQueriesOutput)

summarizer_agent = summarization_template | reasoning_llm_1

complex_gen_agent = react_agent(model=reasoning_llm_2, tools=tools)

reflection_agent = reflection_template | reasoning_llm_1.with_structured_output(ReflectionOutput)


# ---------------------------------------------------------------------------------------------------
# OrthodoxAI v2
# ---------------------------------------------------------------------------------------------------

