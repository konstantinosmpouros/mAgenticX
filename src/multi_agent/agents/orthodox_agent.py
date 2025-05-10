from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

# System prompts and Agentic names
from config import AGENT_NAMES
from prompts.system import (
    ANALYZER_SYSTEM_PROMPT,
    SUMMARIZER_SYSTEM_PROMPT,
    GENERATION_SYSTEM_PROMPT,
    REFLECTION_SYSTEM_PROMPT,
    RETRIEVAL_SYSTEM_PROMPT,
)

# Agentic template classes
from agents.templates.custom import Structured_Agent, Agent, ReAct_Agent

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


analysis_agent = Structured_Agent(
    name=AGENT_NAMES["Analyzer"],
    llm=reasoning_llm_2,
    system_prompt=ANALYZER_SYSTEM_PROMPT,
    structure_response=AnalyzerOutput,
)

query_gen_agent = Structured_Agent(
    name=AGENT_NAMES["Retrieval"],
    llm=reasoning_llm_2,
    system_prompt=RETRIEVAL_SYSTEM_PROMPT,
    structure_response=RetrievalQueriesOutput,
)

reflection_agent = Structured_Agent(
    name=AGENT_NAMES["Reflection"],
    llm=reasoning_llm_1,
    system_prompt=REFLECTION_SYSTEM_PROMPT,
    structure_response=ReflectionOutput,
)

summarizer_agent = Agent(
    name=AGENT_NAMES["Summarizer"],
    llm=reasoning_llm_1,
    system_prompt=SUMMARIZER_SYSTEM_PROMPT,
)

tools = financial_tools | search_tools | articles_tools | computer_vision_tools
# tools = computer_vision_tools
generation_agent = ReAct_Agent(
    name=AGENT_NAMES["Generator"],
    llm=reasoning_llm_2,
    system_prompt=GENERATION_SYSTEM_PROMPT,
    tools=tools
)

