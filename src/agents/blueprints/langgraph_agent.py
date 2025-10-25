from typing import Any, Dict, List, Mapping, Optional, Sequence, Type

from langchain.prompts import ChatPromptTemplate
from langchain.schema.runnable import RunnableLambda
from langgraph.graph import StateGraph

from agui import AGUIEmitter
from utils import make_merge_with_template
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
        
        # Compiled workflow graph
        self.graph = None
        
        # Precompile the workflow so subclasses can invoke immediately
        self._ensure_graph_compiled()



    # ---------------------------------------------------------------------
    # Metadata & utilities
    # ---------------------------------------------------------------------
    @property
    def metadata(self) -> Dict[str, str]:
        """Expose a lightweight metadata dictionary (name, version)."""
        return {
            "name": self.name,
            "version": self.version,
            "tool_count": str(len(self.tools)),
            "tools_received": self.config_tool_names,
            "tools_resolved": self.tools_names,
        }



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
    def graph_state_type(self) -> Type[Any]:
        """Return the state container used when initialising the LangGraph."""
        raise NotImplementedError("Subclasses must implement graph_state_type().")


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
        state_type = self.graph_state_type()
        if state_type is None:
            raise ValueError("graph_state_type() must return a state class.")
        
        graph = StateGraph(state_type)
        self.register_graph_nodes(graph)
        self.register_graph_edges(graph)
        return graph


    def build(self) -> None:
        """
        Compile the workflow into an executable graph.
        
        Optionally accepts a config source or an explicit tool selector that
        overrides previous selections before compiling.
        """
        
        if self.graph is not None:
            return

        graph = self.workflow()
        if not isinstance(graph, StateGraph):
            raise TypeError("workflow() must return a LangGraph StateGraph instance.")
        
        self.graph = graph.compile()



    # ---------------------------------------------------------------------
    # Async inference functions
    # ---------------------------------------------------------------------
    async def ainvoke(self, *args: Any, **kwargs: Any):
        return await self.graph.ainvoke(*args, **kwargs)


    async def astream(self, *args: Any, **kwargs: Any):
        async for chunk in self.graph.astream(*args, **kwargs):
            yield chunk



    # ---------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------
    def merge_with_template(self, template: ChatPromptTemplate) -> RunnableLambda:
        """Return a Runnable that injects the agent's system template."""
        return RunnableLambda(make_merge_with_template(template))


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


    def _ensure_graph_compiled(self):
        """Compile the workflow on first use and return the runnable graph."""
        if self.graph is None:
            self.build()
        return self.graph
