from retail_agents.retail_agent_v1.nodes import (
    analysis,
    check_intent,
    simple_generation,
    query_gen,
    query_execution,
    check_sql_results,
    complex_generation,
)

from langgraph.graph import START, END, StateGraph
from retail_agents.retail_agent_v1.states import RetailV1_State


# Initialize the state machine workflow with the RetailV1 state definitions
workflow = StateGraph(RetailV1_State)

# Add the nodes
workflow.add_node("analysis", analysis)
workflow.add_node("simple_generation", simple_generation)
workflow.add_node("query_gen", query_gen)
workflow.add_node("query_execution", query_execution)
workflow.add_node("complex_generation", complex_generation)

# Define the edges of the workflow
workflow.add_edge(START, "analysis")
workflow.add_conditional_edges(
    "analysis",
    check_intent,
    {
        "query_gen": "query_gen",
        "simple_generation": "simple_generation",
    },
)
workflow.add_edge("simple_generation", END)
workflow.add_edge("query_gen", "query_execution")
workflow.add_conditional_edges(
    "query_execution",
    check_sql_results,
    {
        "query_gen": "query_gen",
        "complex_generation": "complex_generation",
    }
)
workflow.add_edge("complex_generation", END)


# Compile the workflow
agent = workflow.compile()


