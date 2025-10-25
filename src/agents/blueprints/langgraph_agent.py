import json
from typing import Any, Dict, List, Mapping, Optional, Sequence, Type
from pydantic import BaseModel

from langgraph.graph import StateGraph

from agui import AGUIEmitter
from tools import (
    articles_tools,
    computer_vision_tools,
    financial_tools,
    search_tools,
)

ConfigSource = Mapping[str, Any]


class LangGraphAgent:
    """Reusable parent template providing shared agent infrastructure.
    
    Subclasses inherit:
        - An AG-UI emitter instance for consistent UI event streaming.
        - Prompt merge helpers for combining system templates with user input.
        - A configurable tool registry that is filtered by external config.
        - A build lifecycle that compiles LangGraph workflows into runnable graphs.

    Concrete agent templates customize their behavior by implementing the trio of
    graph hooks: ``graph_state_type``, ``register_graph_nodes`` and
    ``register_graph_edges``. The default ``workflow`` implementation will invoke
    those hooks in order to assemble the graph before compilation. Async execution
    helpers (``ainvoke``/``astream``) are provided so subclasses can focus on graph
    construction only.
    """

    name: str = "base-agent"
    version: str = "0.0.1"

    agui: AGUIEmitter = AGUIEmitter()

    tool_registry: Sequence[Any] = (
        *financial_tools,
        *search_tools,
        *articles_tools,
        *computer_vision_tools,
    )

    def __init__(self, *, config: Optional[ConfigSource] = None) -> None:
        # Configuration
        self.config: Dict[str, Any] = self._validate_config(config) if config else {}
        
        # Configured tool selectors
        self.config_tools: Sequence[Mapping[str, Any]] = self.config.get("tools", [])
        self.config_tool_names: List[str] = [item["tool_name"] for item in self.config_tools] if self.config_tools else []
        
        # Resolved tools
        self.tools: List[Any] = self.resolve_tools()
        self.tools_names: List[str] = [tool.name for tool in self.tools]
        
        # Agent components
        self.state: Type[BaseModel] | None = None
        self.agents: Any = None
        self.nodes: Any = None
        self.graph = None



    # ---------------------------------------------------------------------
    # Metadata & utilities
    # ---------------------------------------------------------------------
    @property
    def metadata(self) -> Dict[str, str]:
        """Expose a lightweight metadata dictionary."""
        return {"name": self.name, "version": self.version}



    # ---------------------------------------------------------------------
    # Tool management
    # ---------------------------------------------------------------------
    def resolve_tools(self) -> List[Any]:
        """Resolve validated tool names into concrete tool instances."""
        if not self.config_tool_names:
            return []
        
        tool_lookup: Dict[str, Any] = {tool.name: tool for tool in self.tool_registry}
        resolved: List[Any] = []
        seen: set[str] = set()
        
        for key in self.config_tool_names:
            tool = tool_lookup.get(key)
            if tool is None:
                raise KeyError(f"Unknown tool selector '{key}'.")
            
            if key not in seen:
                resolved.append(tool)
                seen.add(key)
        
        return resolved



    # ---------------------------------------------------------------------
    # Graph/Workflow lifecycle
    # ---------------------------------------------------------------------
    def register_agents(self) -> None:
        """Instantiate LLM chains / helpers and store them on ``self.agents``."""
        raise NotImplementedError("Subclasses must implement register_agents().")


    def register_nodes(self) -> None:
        """Create node callables (usually closing over ``self.agents``/``self.agui``)."""
        raise NotImplementedError("Subclasses must implement register_nodes().")


    def register_agents_and_nodes(self) -> None:
        """
        Default hook that initialize agents then nodes once per template instance.
        Automatically invoked by ``workflow()`` before any graph wiring occurs, so
        subclasses normally override only ``register_agents`` / ``register_nodes``.
        """
        if self.agents is not None and self.nodes is not None:
            return
        self.register_agents()
        self.register_nodes()


    def register_graph_nodes(self, graph: StateGraph) -> None:
        """Attach node handlers to the provided graph instance."""
        raise NotImplementedError("Subclasses must implement register_graph_nodes().")


    def register_graph_edges(self, graph: StateGraph) -> None:
        """Connect graph nodes with edges or conditional routes."""
        raise NotImplementedError("Subclasses must implement register_graph_edges().")


    def workflow(self) -> StateGraph:
        """
        Assemble and return a LangGraph ``StateGraph`` for the agent.
        
        Subclasses may override this method directly, but most implementations will
        benefit from customizing the three hook methods invoked here instead.
        """
        if self.state is None:
            raise ValueError("Subclasses must assign a state model before build().")
        
        if self.agents is None or self.nodes is None:
            self.register_agents_and_nodes()
        
        graph = StateGraph(self.state)
        self.register_graph_nodes(graph)
        self.register_graph_edges(graph)
        return graph


    def build(self) -> None:
        """Compile the workflow into an executable graph."""
        if self.graph is not None:
            return
        
        graph = self.workflow()
        if not isinstance(graph, StateGraph):
            raise TypeError("workflow() must return a LangGraph StateGraph instance.")
        
        self.graph = graph.compile()
        return



    # ---------------------------------------------------------------------
    # Async inference function
    # ---------------------------------------------------------------------
    async def astream(self, *args: Any, **kwargs: Any):
        async for chunk in self.graph.astream(*args, **kwargs):
            # If nodes emit pre-encoded SSE frames (AG-UI EventEncoder), forward as-is
                if isinstance(chunk, (str, bytes)):
                    if isinstance(chunk, str):
                        yield chunk.encode("utf-8")
                    else:
                        yield chunk
                else:
                    # Fallback: wrap dicts as SSE data lines
                    yield ("data: " + json.dumps(chunk) + "\n\n").encode("utf-8")



    # ---------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------
    def _validate_config(self, config: ConfigSource) -> Dict[str, Any]:
        """Validate and normalise a config mapping coming from the UI."""
        # Validate config type
        if not isinstance(config, Mapping):
            raise TypeError("Agent config must be provided as a mapping (dict).")
        data = dict(config)
        
        # Validate tool entries
        tools = data.get("tools")
        if tools is not None:
            if isinstance(tools, str) or not isinstance(tools, Sequence):
                raise TypeError("Agent config 'tools' must be a list of tool mappings.")
            data["tools"] = self._validate_tool_entries(tools)
        
        return data


    @staticmethod
    def _validate_tool_entries(tools: Sequence[Any]) -> List[Mapping[str, Any]]:
        """Return validated tool definitions while preserving extra parameters."""
        if isinstance(tools, str) or not isinstance(tools, Sequence):
            raise TypeError("Tool entries must be provided as a list of mappings.")
        
        normalised: List[Dict[str, Any]] = []
        for tool in tools:
            # Validate entry type
            if not isinstance(tool, Mapping):
                raise TypeError("Each tool entry must be a mapping containing at least a 'tool_name'.")
            candidate = dict(tool)
            
            # Validate tool name
            raw_name = candidate.get("tool_name")
            if not isinstance(raw_name, str) or not raw_name.strip():
                raise ValueError("Each tool entry must provide a non-empty 'tool_name' string.")
            
            candidate["tool_name"] = raw_name.strip()
            
            # Add to normalised list after validation
            normalised.append(candidate)
            
        return normalised
