from langgraph.graph import StateGraph, START, END

from blueprints import LangGraphAgent
from langgraph_agents.hr_policies_agent_v1.agents import build_hr_agents
from langgraph_agents.hr_policies_agent_v1.nodes import (
    HRPoliciesV1_State,
    build_hr_nodes,
)


class HRPoliciesAgentV1(LangGraphAgent):
    """LangGraph template implementation for the HR Policies workflow."""

    name = "hr-policies-agent-v1"
    agent_id = "HR-Policies v1"
    label = "HR Policies"
    version = "1.0.0"
    description = "HR policies, leave, benefits, and procedures"
    icon = "Building2"

    def __init__(self, *, config=None):
        super().__init__(config=config)
        self.state = HRPoliciesV1_State


    def register_agents(self) -> None:
        self.agents = build_hr_agents(tools=self.tools)


    def register_nodes(self) -> None:
        self.nodes = build_hr_nodes(agents=self.agents, agui=self.agui_emitter)


    def register_graph_nodes(self, graph: StateGraph) -> None:
        graph.add_node("analysis", self.nodes.analysis)
        graph.add_node("simple_generation", self.nodes.simple_generation)
        graph.add_node("query_gen", self.nodes.query_gen)
        graph.add_node("retrieval", self.nodes.retrieval)
        graph.add_node("doc_ranking", self.nodes.doc_ranking)
        graph.add_node("reflectioner", self.nodes.reflection)
        graph.add_node("summarizer", self.nodes.summarization)
        graph.add_node("complex_generation", self.nodes.complex_generation)


    def register_graph_edges(self, graph: StateGraph) -> None:
        graph.add_edge(START, "analysis")
        graph.add_conditional_edges(
            "analysis",
            self.nodes.check_if_hr,
            {
                "query_gen": "query_gen",
                "simple_generation": "simple_generation",
            },
        )
        graph.add_edge("simple_generation", END)
        
        graph.add_edge("query_gen", "retrieval")
        graph.add_edge("retrieval", "doc_ranking")
        graph.add_edge("doc_ranking", "reflectioner")
        graph.add_conditional_edges(
            "reflectioner",
            self.nodes.check_reflection,
            {
                "query_gen": "query_gen",
                "summarizer": "summarizer",
            },
        )
        graph.add_edge("summarizer", "complex_generation")
        graph.add_edge("complex_generation", END)
