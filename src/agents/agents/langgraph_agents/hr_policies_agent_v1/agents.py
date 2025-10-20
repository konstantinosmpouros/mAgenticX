# Custom Runnable step in chains
from langchain.schema.runnable import RunnableLambda

from utils import make_merge_with_template

# OpenAI LLMs & agents
from llms import (
    gpt_o3_mini,
    gpt_4o,
    gpt_4_1
)
from langgraph.prebuilt import create_react_agent as react_agent

# Structured Outputs
from agents.langgraph_agents.hr_policies_agent_v1.structured_outputs import (
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
from agents.langgraph_agents.hr_policies_agent_v1.prompt_templates import (
    analyzer_template,
    summarization_template,
    reflection_template,
    query_gen_no_reflection_template,
    query_gen_with_reflection_template,
    ranking_template,
)

# ---------------------------------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------------------------------
merge_runnable = RunnableLambda(make_merge_with_template(analyzer_template))
analysis_agent = merge_runnable | gpt_4o.with_structured_output(AnalyzerOutput)

simple_gen_agent = react_agent(model=gpt_o3_mini, tools=tools)

query_reflective_agent = query_gen_with_reflection_template | gpt_o3_mini.with_structured_output(RetrievalQueriesOutput)
query_no_reflective_agent = query_gen_no_reflection_template | gpt_o3_mini.with_structured_output(RetrievalQueriesOutput)

doc_ranking_agent = ranking_template | gpt_4_1.with_structured_output(RankingOutput)

summarizer_agent = summarization_template | gpt_4o

complex_gen_agent = react_agent(model=gpt_o3_mini, tools=tools)

reflection_agent = reflection_template | gpt_4o.with_structured_output(ReflectionOutput)

