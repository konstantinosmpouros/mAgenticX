# Custom Runnable step in chains
from typing import Dict, List, Union
from langchain.schema.runnable import RunnableLambda
from langchain.prompts import ChatPromptTemplate
from langchain.schema import BaseMessage

from utils import normalise_user_input

# OpenAI LLMs & agents
from llms import (
    gpt_o3_mini,
    gpt_4o,
    gpt_4_1
)
from langgraph.prebuilt import create_react_agent as react_agent

# Structured Outputs
from hr_agents.hr_policies_agent_v1.structured_outputs import (
    AnalyzerOutput,
    ReflectionOutput,
    RetrievalQueriesOutput,
    RankingOutput
)

# Tools
from tools import (
    financial_tools,
    search_tools,
    articles_tools,
    computer_vision_tools
)
tools = financial_tools + search_tools + articles_tools + computer_vision_tools

# Prompt Template
from hr_agents.hr_policies_agent_v1.prompt_templates import (
    analyzer_template,
    summarization_template,
    reflection_template,
    query_gen_no_reflection_template,
    query_gen_with_reflection_template,
    ranking_template,
)

# ---------------------------------------------------------------------------------------------------
# Helper to merge system + user messages
# ---------------------------------------------------------------------------------------------------
def _merge_templates(user_input: Union[List[Dict[str, str]], ChatPromptTemplate, List[BaseMessage]]) -> List[BaseMessage]:
    """Return analyzer system prompt + cleaned user messages."""
    user_msgs: List[BaseMessage] = normalise_user_input(user_input)

    merged_tpl = ChatPromptTemplate.from_messages(
        analyzer_template.messages + user_msgs
    )
    return merged_tpl.format_messages()



# ---------------------------------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------------------------------

merge_runnable = RunnableLambda(_merge_templates)
analysis_agent = merge_runnable | gpt_4o.with_structured_output(AnalyzerOutput)

simple_gen_agent = react_agent(model=gpt_o3_mini, tools=tools)

query_reflective_agent = query_gen_with_reflection_template | gpt_o3_mini.with_structured_output(RetrievalQueriesOutput)
query_no_reflective_agent = query_gen_no_reflection_template | gpt_o3_mini.with_structured_output(RetrievalQueriesOutput)

doc_ranking_agent = ranking_template | gpt_4_1.with_structured_output(RankingOutput)

summarizer_agent = summarization_template | gpt_4o

complex_gen_agent = react_agent(model=gpt_o3_mini, tools=tools)

reflection_agent = reflection_template | gpt_4o.with_structured_output(ReflectionOutput)

