from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

# OpenAI LLMs
from llms.openai import reasoning_llm_1, reasoning_llm_2

# Structured Outputs
from llms.structured_outputs import (
    AnalyzerOutput,
    ReflectionOutput,
    RetrievalQueriesOutput
)

# Tools
from tools import (
    financial_tools,
    search_tools,
    articles_tools,
    computer_vision_tools
)
tools = financial_tools | search_tools | articles_tools | computer_vision_tools

# Prompt Template
from prompts.templates.orthodox_templates import (
    analyzer_template,
    summarization_template,
    nonreligious_gen_template,
    religious_gen_template,
    reflection_template,
    query_gen_no_reflection_template,
    query_gen_with_reflection_template
)


analysis_agent = analyzer_template | reasoning_llm_2.with_structured_output(AnalyzerOutput)

simple_gen_agent = nonreligious_gen_template | reasoning_llm_2

query_reflective_agent = query_gen_with_reflection_template | reasoning_llm_2.with_structured_output(RetrievalQueriesOutput)

query_no_reflective_agent = query_gen_no_reflection_template | reasoning_llm_2.with_structured_output(RetrievalQueriesOutput)

summarizer_agent = summarization_template | reasoning_llm_1

complex_gen_agent = religious_gen_template | reasoning_llm_2

reflection_agent = reflection_template | reasoning_llm_1.with_structured_output(ReflectionOutput)

