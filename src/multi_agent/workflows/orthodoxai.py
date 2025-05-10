from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__))).parent
sys.path.append(str(PACKAGE_ROOT))

from nodes.orthodox_nodes import (
    analysis,
    check_if_religious,
    simple_generation,
    query_gen,
    retrieval,
    summarization,
    complex_generation,
    reflection,
    check_reflection,
)

from langgraph.graph import START, END, StateGraph
from states import Orthodox_State

from IPython.display import Image
import base64
import os

# Initialize the workflow
workflow = StateGraph(Orthodox_State)

# Add the nodes
workflow.add_node('analysis', analysis)
workflow.add_node('simple_generation', simple_generation)
workflow.add_node('query_gen', query_gen)
workflow.add_node('retrieval', retrieval)
workflow.add_node('summarizer', summarization)
workflow.add_node('complex_generation', complex_generation)
workflow.add_node('reflectioner', reflection)

# Wire up the two analysis branches
workflow.add_edge(START, "analysis")
workflow.add_conditional_edges(
    "analysis",
    check_if_religious,
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

# Print the architecture of the agent
try: 
    raw = agent.get_graph().draw_mermaid_png()
    if isinstance(raw, str):
        png_bytes = base64.b64decode(raw)
    else:
        png_bytes = raw
    
    out_path = "architectures/orthodox_agent.png"
    with open(out_path, "wb") as f:
        f.write(png_bytes)
except Exception:
    pass



