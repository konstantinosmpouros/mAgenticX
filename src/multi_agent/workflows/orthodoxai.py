from ..nodes.orthodox_nodes import (
    analysis,
    check_if_religious,
    check_generation,
    check_reflection,
    generation,
    query_gen,
    summarization,
    reflection,
    retrieval
)

from langgraph.graph import START, END, StateGraph
from ..states import Orthodox_State

workflow = StateGraph(Orthodox_State)

workflow.add_node('analysis', analysis)
workflow.add_node('query_gen', query_gen)
workflow.add_node('retrieval', retrieval)
workflow.add_node('summarization', summarization)
workflow.add_node('generation', generation)
workflow.add_node('reflection', reflection)


workflow.add_edge(START, 'analysis')
workflow.add_conditional_edges("analysis", check_if_religious)
workflow.add_edge('query_gen', 'retrieval')
workflow.add_edge('retrieval', 'summarization')
workflow.add_edge('summarization', 'generation')
workflow.add_conditional_edges('generation', check_generation)
workflow.add_conditional_edges('reflection', check_reflection)

agent = workflow.compile()
