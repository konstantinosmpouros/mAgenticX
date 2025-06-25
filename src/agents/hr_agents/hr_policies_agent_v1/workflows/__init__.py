from hr_agents.hr_policies_agent_v1.nodes import (
    analysis,
    check_if_hr,
    simple_generation,
    query_gen,
    retrieval,
    summarization,
    complex_generation,
    reflection,
    check_reflection,
    doc_ranking,
)

from langgraph.graph import START, END, StateGraph
from hr_agents.hr_policies_agent_v1.states import HRPoliciesV1_State


# Initialize the workflow
workflow = StateGraph(HRPoliciesV1_State)

# Add the nodes
workflow.add_node('analysis', analysis)
workflow.add_node('simple_generation', simple_generation)
workflow.add_node('query_gen', query_gen)
workflow.add_node('retrieval', retrieval)
workflow.add_node('doc_ranking', doc_ranking)
workflow.add_node('reflectioner', reflection)
workflow.add_node('summarizer', summarization)
workflow.add_node('complex_generation', complex_generation)


# Define the edges of the workflow
workflow.add_edge(START, "analysis")
workflow.add_conditional_edges(
    "analysis",
    check_if_hr,
    {
        "query_gen": "query_gen",
        "simple_generation": "simple_generation",
    },
)
workflow.add_edge("simple_generation", END)
workflow.add_edge("query_gen", "retrieval")
workflow.add_edge("retrieval", "doc_ranking")
workflow.add_edge("doc_ranking", "reflectioner")
workflow.add_conditional_edges(
    "reflectioner",
    check_reflection,
    {
        "query_gen": "query_gen",
        "summarizer": "summarizer",
    },
)
workflow.add_edge("summarizer", "complex_generation")
workflow.add_edge("complex_generation", END)


# Compile the workflow
agent = workflow.compile()


