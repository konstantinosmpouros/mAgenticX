from dataclasses import dataclass
from typing import Any, Sequence

from langchain.chat_models import init_chat_model
from langchain_core.runnables import RunnableLambda
from langgraph.prebuilt import create_react_agent as react_agent

from core.settings import settings
from utils import make_merge_with_template
from langgraph_agents.orthodox_agent_v1.structured_outputs import (
    AnalyzerOutput,
    ReflectionOutput,
    RetrievalQueriesOutput,
)
from langgraph_agents.orthodox_agent_v1.prompt_templates import (
    analyzer_template,
    summarization_template,
    reflection_template,
    query_gen_no_reflection_template,
    query_gen_with_reflection_template,
)


@dataclass
class OrthodoxAgents:
    analysis_agent: Any
    simple_gen_agent: Any
    query_reflective_agent: Any
    query_no_reflective_agent: Any
    summarizer_agent: Any
    complex_gen_agent: Any
    reflection_agent: Any
    tools: Sequence[Any]



def build_orthodox_agents(*, tools: Sequence[Any] | None = None) -> OrthodoxAgents:
    """
    Construct all runnable components used by the orthodox workflow, honoring
    runtime-selected tools when provided.
    """
    workflow = settings.workflows.orthodox
    merge_runnable = RunnableLambda(make_merge_with_template(analyzer_template))
    analysis_agent = merge_runnable | init_chat_model(workflow.analysis_model).with_structured_output(AnalyzerOutput)
    
    simple_gen_agent = react_agent(model=init_chat_model(workflow.simple_generation_model), tools=tools)
    
    query_reflective_agent = query_gen_with_reflection_template | init_chat_model(workflow.query_reflective_model).with_structured_output(RetrievalQueriesOutput)
    query_no_reflective_agent = query_gen_no_reflection_template | init_chat_model(workflow.query_no_reflective_model).with_structured_output(RetrievalQueriesOutput)
    
    summarizer_agent = summarization_template | init_chat_model(workflow.summarization_model)
    
    complex_gen_agent = react_agent(model=init_chat_model(workflow.complex_generation_model), tools=tools)
    
    reflection_agent = reflection_template | init_chat_model(workflow.reflection_model).with_structured_output(ReflectionOutput)
    
    return OrthodoxAgents(
        analysis_agent=analysis_agent,
        simple_gen_agent=simple_gen_agent,
        query_reflective_agent=query_reflective_agent,
        query_no_reflective_agent=query_no_reflective_agent,
        summarizer_agent=summarizer_agent,
        complex_gen_agent=complex_gen_agent,
        reflection_agent=reflection_agent,
        tools=tools,
    )
