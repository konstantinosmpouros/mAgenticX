from dataclasses import dataclass
from typing import Any, Sequence

from langchain.schema.runnable import RunnableLambda
from langgraph.prebuilt import create_react_agent as react_agent

from utils import make_merge_with_template
from llms import gpt_o4_mini, gpt_4_1_mini, gpt_4o
from agents.langgraph_agents.retail_agent_v1.structured_outputs import (
    AnalysisOutput,
    SQLQueryOutput,
)
from agents.langgraph_agents.retail_agent_v1.prompt_templates import (
    analyzer_template,
    sql_gen_template,
    sql_error_gen_template,
)


@dataclass
class RetailAgents:
    """Container for all runnable components used by the retail workflow."""
    analysis_agent: Any
    simple_gen_agent: Any
    sql_gen_agent: Any
    sql_error_gen_agent: Any
    answer_agent: Any
    tools: Sequence[Any]


def build_retail_agents(*, tools: Sequence[Any] | None = None) -> RetailAgents:
    """
    Construct the runnable building blocks for the retail workflow.
    
    Parameters
    ----------
    tools:
        Optional sequence of LangChain tool instances selected at runtime. If
        omitted or empty, the full default retail toolset is used.
    """
    # Build runnable chains
    merge_runnable = RunnableLambda(make_merge_with_template(analyzer_template))
    analysis_agent = merge_runnable | gpt_4o.with_structured_output(AnalysisOutput)
    
    simple_gen_agent = react_agent(model=gpt_4_1_mini, tools=tools)
    sql_gen_agent = sql_gen_template | gpt_o4_mini.with_structured_output(SQLQueryOutput)
    sql_error_gen_agent = sql_error_gen_template | gpt_o4_mini.with_structured_output(SQLQueryOutput)
    answer_agent = react_agent(model=gpt_4o, tools=tools)
    
    return RetailAgents(
        analysis_agent=analysis_agent,
        simple_gen_agent=simple_gen_agent,
        sql_gen_agent=sql_gen_agent,
        sql_error_gen_agent=sql_error_gen_agent,
        answer_agent=answer_agent,
        tools=tools,
    )


