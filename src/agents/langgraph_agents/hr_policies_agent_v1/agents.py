from dataclasses import dataclass
from typing import Any, Sequence

from langchain.schema.runnable import RunnableLambda
from langgraph.prebuilt import create_react_agent as react_agent

from utils import make_merge_with_template
from llms import gpt_o3_mini, gpt_4o, gpt_4_1
from langgraph_agents.hr_policies_agent_v1.structured_outputs import (
    AnalyzerOutput,
    ReflectionOutput,
    RetrievalQueriesOutput,
    RankingOutput,
)
from langgraph_agents.hr_policies_agent_v1.prompt_templates import (
    analyzer_template,
    summarization_template,
    reflection_template,
    query_gen_no_reflection_template,
    query_gen_with_reflection_template,
    ranking_template,
)

@dataclass
class HRAgents:
    analysis_agent: Any
    simple_gen_agent: Any
    query_reflective_agent: Any
    query_no_reflective_agent: Any
    doc_ranking_agent: Any
    summarizer_agent: Any
    complex_gen_agent: Any
    reflection_agent: Any
    tools: Sequence[Any]


def build_hr_agents(*, tools: Sequence[Any] | None = None) -> HRAgents:
    """Construct all runnable components for the HR Policies workflow."""
    
    merge_runnable = RunnableLambda(make_merge_with_template(analyzer_template))
    analysis_agent = merge_runnable | gpt_4o.with_structured_output(AnalyzerOutput)
    
    simple_gen_agent = react_agent(model=gpt_o3_mini, tools=tools)
    
    query_reflective_agent = query_gen_with_reflection_template | gpt_o3_mini.with_structured_output(RetrievalQueriesOutput)
    query_no_reflective_agent = query_gen_no_reflection_template | gpt_o3_mini.with_structured_output(RetrievalQueriesOutput)
    
    doc_ranking_agent = ranking_template | gpt_4_1.with_structured_output(RankingOutput)
    
    summarizer_agent = summarization_template | gpt_4o
    complex_gen_agent = react_agent(model=gpt_o3_mini, tools=tools)
    
    reflection_agent = reflection_template | gpt_4o.with_structured_output(ReflectionOutput)
    
    return HRAgents(
        analysis_agent=analysis_agent,
        simple_gen_agent=simple_gen_agent,
        query_reflective_agent=query_reflective_agent,
        query_no_reflective_agent=query_no_reflective_agent,
        doc_ranking_agent=doc_ranking_agent,
        summarizer_agent=summarizer_agent,
        complex_gen_agent=complex_gen_agent,
        reflection_agent=reflection_agent,
        tools=tools,
    )

