from ..states import Orthodox_State
from ..agents.orthodox_agent import (
    analysis_agent,
    reflection_agent,
    query_gen_agent,
    generation_agent,
    summarizer_agent
)

from langgraph.types import Command
from typing import Literal

def analysis(state: Orthodox_State) -> Orthodox_State:
    user_msg = state['user_input']
    analysis_result = analysis_agent.invoke(user_msg)
    return {'analysis_results': analysis_result}

def check_if_religious(state: Orthodox_State) -> Command[Literal["node_b", "node_c"]]:
    return Command(
        goto='retrieval' if state['analysis_results'].is_religious == "Religious" else 'generation'
    )

def query_gen(state: Orthodox_State):
    pass

def retrieval(state: Orthodox_State):
    pass

def summarization(state: Orthodox_State):
    pass

def generation(state: Orthodox_State):
    pass

def reflection(state: Orthodox_State):
    pass

def should_end(state: Orthodox_State):
    pass




