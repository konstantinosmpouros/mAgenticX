from dataclasses import dataclass
from typing import Any, Sequence

from langchain.chat_models import init_chat_model
from langchain_core.runnables import RunnableLambda
from langgraph.prebuilt import create_react_agent as react_agent

from core.configs import configs
from utils import make_merge_with_template
from langgraph_agents.retail_agent_v1.structured_outputs import (
    AnalysisOutput,
    SQLQueryOutput,
)
from langgraph_agents.retail_agent_v1.prompt_templates import (
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
    workflow = configs.workflows.retail
    # Build runnable chains
    merge_runnable = RunnableLambda(make_merge_with_template(analyzer_template))
    analysis_agent = merge_runnable | init_chat_model(workflow.analysis_model).with_structured_output(AnalysisOutput)
    
    simple_gen_agent = react_agent(model=init_chat_model(workflow.simple_generation_model), tools=tools)
    sql_gen_agent = sql_gen_template | init_chat_model(workflow.sql_generation_model).with_structured_output(SQLQueryOutput)
    sql_error_gen_agent = sql_error_gen_template | init_chat_model(workflow.sql_error_generation_model).with_structured_output(SQLQueryOutput)
    answer_agent = react_agent(model=init_chat_model(workflow.answer_generation_model), tools=tools)
    
    return RetailAgents(
        analysis_agent=analysis_agent,
        simple_gen_agent=simple_gen_agent,
        sql_gen_agent=sql_gen_agent,
        sql_error_gen_agent=sql_error_gen_agent,
        answer_agent=answer_agent,
        tools=tools,
    )

