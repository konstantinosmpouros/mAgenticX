# Custom Runnable step in chains
from typing import List, Union, Dict, cast
from langchain.schema.runnable import RunnableLambda
from langchain.prompts import ChatPromptTemplate
from langchain.schema import HumanMessage, BaseMessage, SystemMessage, AIMessage

# OpenAI LLMs & agents
from retail_agents.retail_agent_v1.llms.openai import (
    reasoning_llm_2,
    llm_3
)
from retail_agents.retail_agent_v1.agents.templates.prebuilt import react_agent

# Structured Outputs
from retail_agents.retail_agent_v1.llms.structured_outputs import AnalysisOutput, SQLQueryOutput

# Tools
from retail_agents.retail_agent_v1.tools import (
    financial_tools,
    search_tools,
    articles_tools,
    computer_vision_tools
)
tools = financial_tools + search_tools + articles_tools + computer_vision_tools

# Prompt Template
from retail_agents.retail_agent_v1.prompts.templates import (
    analyzer_template,
    sql_gen_template,
    sql_error_gen_template,
)


# ---------------------------------------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------------------------------------

def _dict_to_message(d: Dict[str, str]) -> BaseMessage | None:
    """Convert dict → BaseMessage, skip system role."""
    role = d.get("role", "").lower()
    content = d.get("content", "")
    if role in {"user", "human"}:
        return HumanMessage(content=content)
    if role in {"assistant", "ai"}:
        return AIMessage(content=content)
    # ignore any system message coming from outside
    return None

def _strip_system(msgs: List[BaseMessage]) -> List[BaseMessage]:
    """Remove SystemMessage objects."""
    return [m for m in msgs if not isinstance(m, SystemMessage)]

def _normalise(inp: Union[List[Dict[str, str]], ChatPromptTemplate, List[BaseMessage]]) -> List[BaseMessage]:
    """Bring each allowed input shape to List[BaseMessage] w/o system msgs."""
    
    # Case 1 – ChatPromptTemplate
    if isinstance(inp, ChatPromptTemplate):
        msgs = inp.format_messages()

    # Case 2 – list[BaseMessage]
    elif (isinstance(inp, (list, tuple)) and (not inp or isinstance(inp[0], BaseMessage))):
        msgs = list(cast(List[BaseMessage], inp))

    # Case 3 – list[dict[str,str]]
    elif (isinstance(inp, (list, tuple)) and inp and isinstance(inp[0], dict)):
        msgs = [
            m for m in
            (_dict_to_message(cast(Dict[str, str], d)) for d in inp)
            if m is not None
        ]
    else:
        raise TypeError(
            "The user_input passed to the must be ChatPromptTemplate, list[BaseMessage], "
            "or list[dict[str,str]] (got {type(inp)})"
        )

    return _strip_system(msgs)

def _merge_templates(user_input: Union[List[Dict[str, str]], ChatPromptTemplate, List[BaseMessage]]) -> List[BaseMessage]:
    """Return analyzer system prompt + cleaned user messages."""
    user_msgs: List[BaseMessage] = _normalise(user_input)

    merged_tpl = ChatPromptTemplate.from_messages(
        analyzer_template.messages + user_msgs
    )
    return merged_tpl.format_messages()



# ---------------------------------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------------------------------

merge_runnable = RunnableLambda(_merge_templates)
analysis_agent = merge_runnable | llm_3.with_structured_output(AnalysisOutput)

simple_gen_agent = react_agent(model=llm_3, tools=tools)

sql_gen_agent = sql_gen_template | reasoning_llm_2.with_structured_output(SQLQueryOutput)
sql_error_gen_agent = sql_error_gen_template | reasoning_llm_2.with_structured_output(SQLQueryOutput)

answer_agent = react_agent(model=llm_3, tools=tools)