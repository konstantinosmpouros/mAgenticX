# Custom Runnable step in chains
from typing import Dict, List, Union
from langchain.schema.runnable import RunnableLambda
from langchain.prompts import ChatPromptTemplate
from langchain.schema import BaseMessage

from utils import normalise_user_input

# OpenAI LLMs & agents
from llms import (
    gpt_o4_mini,
    gpt_4_1_mini,
    gpt_4o,
    gpt_5
)
from langgraph.prebuilt import create_react_agent as react_agent

# Structured Outputs
from retail_agents.retail_agent_v1.structured_outputs import (
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
from retail_agents.retail_agent_v1.prompt_templates import (
    analyzer_template,
    sql_gen_template,
    sql_error_gen_template,
)


# ---------------------------------------------------------------------------------------------------
def _merge_templates(user_input: Union[List[Dict[str, str]], ChatPromptTemplate, List[BaseMessage]]) -> List[BaseMessage]:
    """Return analyzer system prompt + cleaned user messages."""
    user_msgs: List[BaseMessage] = normalise_user_input(user_input)
    merged_tpl = ChatPromptTemplate.from_messages(
        analyzer_template.messages + user_msgs
    )
    print(f"--- Merged template ---\n{merged_tpl}\n---------------------")
    return merged_tpl.format_messages()



# ---------------------------------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------------------------------

merge_runnable = RunnableLambda(_merge_templates)
analysis_agent = merge_runnable | gpt_4o.with_structured_output(AnalysisOutput)

simple_gen_agent = react_agent(model=gpt_4_1_mini, tools=tools)

sql_gen_agent = sql_gen_template | gpt_o4_mini.with_structured_output(SQLQueryOutput)
sql_error_gen_agent = sql_error_gen_template | gpt_o4_mini.with_structured_output(SQLQueryOutput)

answer_agent = react_agent(model=gpt_5, tools=tools)

