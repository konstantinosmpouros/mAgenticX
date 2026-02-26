from langgraph.graph import StateGraph, START, END

from blueprints import LangGraphAgent
from langgraph_agents.orthodox_agent_v1.agents import build_orthodox_agents
from langgraph_agents.orthodox_agent_v1.nodes import (
    OrthodoxV1_State,
    build_orthodox_nodes,
)


class OrthodoxAgentV1(LangGraphAgent):
    """LangGraph template implementation for the OrthodoxAI v1 workflow."""

    name = "orthodox-agent-v1"
    agent_id = "OrthodoxAI v1"
    label = "OrthodoxAI"
    version = "1.0.0"
    description = "Orthodox biblical and theological insights"
    icon = "BookOpen"

    def __init__(self, *, config=None):
        super().__init__(config=config)
        self.state = OrthodoxV1_State

    def register_agents(self) -> None:
        return build_orthodox_agents(tools=self.tools)


    def register_nodes(self) -> None:
        return build_orthodox_nodes(agents=self.agents, agui=self.agui_emitter)

    def register_graph_nodes(self, graph: StateGraph) -> None:
        graph.add_node("analysis", self.nodes.analysis)
        graph.add_node("simple_generation", self.nodes.simple_generation)
        graph.add_node("query_gen", self.nodes.query_gen)
        graph.add_node("retrieval", self.nodes.retrieval)
        graph.add_node("summarizer", self.nodes.summarization)
        graph.add_node("complex_generation", self.nodes.complex_generation)
        graph.add_node("reflectioner", self.nodes.reflection)
        return graph


    def register_graph_edges(self, graph: StateGraph) -> None:
        graph.add_edge(START, "analysis")
        graph.add_conditional_edges(
            "analysis",
            self.nodes.check_if_religious,
            {
                "query_gen": "query_gen",
                "simple_generation": "simple_generation",
            },
        )
        graph.add_edge("simple_generation", END)
        
        graph.add_edge("query_gen", "retrieval")
        graph.add_edge("retrieval", "summarizer")
        graph.add_edge("summarizer", "complex_generation")
        graph.add_edge("complex_generation", "reflectioner")
        
        graph.add_conditional_edges(
            "reflectioner",
            self.nodes.check_reflection,
            {
                "query_gen": "query_gen",
                "end": END,
            },
        )
        return graph
