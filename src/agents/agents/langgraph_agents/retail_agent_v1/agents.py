# Custom Runnable step in chains
from langchain.schema.runnable import RunnableLambda

from utils import make_merge_with_template

# OpenAI LLMs & agents
from llms import (
    gpt_o4_mini,
    gpt_4_1_mini,
    gpt_4o,
    gpt_5
)
from langgraph.prebuilt import create_react_agent as react_agent

# Structured Outputs
from agents.langgraph_agents.retail_agent_v1.structured_outputs import (
    AnalysisOutput,
    SQLQueryOutput,
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
from agents.langgraph_agents.retail_agent_v1.prompt_templates import (
    analyzer_template,
    sql_gen_template,
    sql_error_gen_template,
)


# ---------------------------------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------------------------------
merge_runnable = RunnableLambda(make_merge_with_template(analyzer_template))
analysis_agent = merge_runnable | gpt_4o.with_structured_output(AnalysisOutput)

simple_gen_agent = react_agent(model=gpt_4_1_mini, tools=tools)

sql_gen_agent = sql_gen_template | gpt_o4_mini.with_structured_output(SQLQueryOutput)
sql_error_gen_agent = sql_error_gen_template | gpt_o4_mini.with_structured_output(SQLQueryOutput)

answer_agent = react_agent(model=gpt_5, tools=tools)

