from langgraph.graph import StateGraph

from blueprints import LangGraphAgent
from langgraph_agents.retail_agent_v1.agents import build_retail_agents
from langgraph_agents.retail_agent_v1.nodes import RetailV1_State, build_retail_nodes


class RetailAgentV1(LangGraphAgent):
    """LangGraph template implementation for the retail v1 workflow."""

    name = "retail-agent-v1"
    agent_id = "Retail Agent v1"
    label = "Retail Agent"
    version = "1.0.0"
    description = "Product discovery, pricing, inventory and promotions"
    icon = "ShoppingBag"
    stream_mode = "custom"

    def __init__(self, *, config=None):
        super().__init__(config=config)
        self.state = RetailV1_State
        self.build()


    def register_agents(self) -> None:
        """Build runtime-specific agent chains using selected tools."""
        self.agents = build_retail_agents(tools=self.tools)


    def register_nodes(self) -> None:
        """Create node callables that close over the configured agents."""
        self.nodes = build_retail_nodes(agents=self.agents, agui=self.agui)


    def register_graph_nodes(self, graph: StateGraph) -> None:
        graph.add_node("analysis", self.nodes.analysis)
        graph.add_node("simple_generation", self.nodes.simple_generation)
        graph.add_node("query_gen", self.nodes.query_gen)
        graph.add_node("query_execution", self.nodes.query_execution)
        graph.add_node("complex_generation", self.nodes.complex_generation)


    def register_graph_edges(self, graph: StateGraph) -> None:
        from langgraph.graph import START, END
        
        graph.add_edge(START, "analysis")
        graph.add_conditional_edges(
            "analysis",
            self.nodes.check_intent,
            {
                "query_gen": "query_gen",
                "simple_generation": "simple_generation",
            },
        )
        graph.add_edge("simple_generation", END)
        graph.add_edge("query_gen", "query_execution")
        graph.add_conditional_edges(
            "query_execution",
            self.nodes.check_sql_results,
            {
                "query_gen": "query_gen",
                "complex_generation": "complex_generation",
            },
        )
        graph.add_edge("complex_generation", END)
