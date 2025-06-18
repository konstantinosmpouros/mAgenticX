from retail_agents.nodes.retail_agent_v1 import (
    analysis,
    check_if_hr,
    simple_generation,
    query_gen,
    retrieval,
    summarization,
    complex_generation,
    reflection,
    check_reflection,
)

from langgraph.graph import START, END, StateGraph
from retail_agents.states import RetailV1_State


# Initialize the workflow
workflow = StateGraph(RetailV1_State)

# Add the nodes
workflow.add_node('analysis', analysis)
workflow.add_node('simple_generation', simple_generation)
workflow.add_node('query_gen', query_gen)
workflow.add_node('retrieval', retrieval)
workflow.add_node('summarizer', summarization)
workflow.add_node('complex_generation', complex_generation)
workflow.add_node('reflectioner', reflection)

# Entry edge
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

# The linear “true” branch
workflow.add_edge("query_gen", "retrieval")
workflow.add_edge("retrieval", "summarizer")
workflow.add_edge("summarizer", "complex_generation")
workflow.add_edge("complex_generation", "reflectioner")

# Wire up the two reflection branches
workflow.add_conditional_edges(
    "reflectioner",
    check_reflection,
    {
        "query_gen": "query_gen",
        "end": END,
    },
)

# Compile the workflow
agent = workflow.compile()



