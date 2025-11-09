import asyncio
import json
import os
import traceback
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Type
from pydantic import BaseModel

from langgraph.graph import StateGraph
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from agui import AGUIEmitter
from tools import (
    articles_tools,
    computer_vision_tools,
    financial_tools,
    search_tools,
)

ConfigSource = Mapping[str, Any]


class LangGraphAgent:
    """Reusable template that wires LangGraph agents into the service runtime.

    Responsibilities shared by every subclass:
        • normalised tool resolution driven by UI/back-end config
        • a consistent AG-UI emitter for streaming thoughts/events
        • a build lifecycle that registers nodes/edges then compiles the graph
        • optional SQLite checkpointing via ``configure_sqlite_checkpointer()``

    Concrete agents implement the three hooks ``register_agents()``,
    ``register_nodes()`` and ``register_graph_edges()`` to describe their
    workflow. The default ``workflow()`` takes care of assembling a
    ``StateGraph`` while ``astream()`` exposes LangGraph's streaming API so the
    FastAPI layer can proxy responses without additional plumbing.
    """

    # Stable slug used for registry lookups and URL routing
    name: str = "base-agent"

    # Human-readable identifiers exposed to downstream consumers
    agent_id: str = "base-agent"
    label: str = "Base Agent"
    version: str = "0.0.1"
    type: str = "langgraph agent"
    description: Optional[str] = None
    icon: Optional[str] = None
    stream_mode: str = "custom"

    agui: AGUIEmitter = AGUIEmitter()

    tool_registry: Sequence[Any] = (
        *financial_tools,
        *search_tools,
        *articles_tools,
        *computer_vision_tools,
    )

    def __init__(
        self,
        *,
        config: Optional[ConfigSource] = None,
        run_config: Optional[Mapping[str, Any]] = None,
    ) -> None:
        # Configuration
        self.config: Dict[str, Any] = self._validate_config(config) if config else {}
        self.run_config: Optional[Mapping[str, Any]] = run_config
        
        # Configured tool selectors
        self.config_tools: Sequence[Mapping[str, Any]] = self.config.get("tools", [])
        self.config_tool_names: List[str] = [item["tool_name"] for item in self.config_tools] if self.config_tools else []
        
        # Resolved tools
        self.tools: List[Any] = self.resolve_tools()
        self.tools_names: List[str] = [tool.name for tool in self.tools]
        
        # LangGraph checkpointer path
        self.checkpointer_path: str = self.checkpoints_db_path()
        
        # Agent components
        self.state: Type[BaseModel] | None = None
        self.agents: Any = None
        self.nodes: Any = None
        self.graph = None



    # ---------------------------------------------------------------------
    # Metadata & utilities
    # ---------------------------------------------------------------------
    @property
    def metadata(self) -> Dict[str, Any]:
        """Expose the class-level manifest for this agent instance."""
        return self.__class__.manifest()


    @classmethod
    def manifest(cls) -> Dict[str, Any]:
        """Return the registry manifest describing this agent template."""
        return {
            "id": cls.agent_id,
            "slug": cls.name,
            "name": cls.label,
            "version": cls.version,
            "type": cls.type,
            "description": cls.description or "",
            "icon": cls.icon or "",
        }



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
        
        self.graph = graph
        return



    # ---------------------------------------------------------------------
    # Async inference function
    # ---------------------------------------------------------------------
    async def astream(
        self,
        payload: Mapping[str, Any],
        run_config: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        """Stream LangGraph chunks as SSE bytes using the configured stream mode."""
        try:
            # Use provided run_config or default to instance's run_config
            cfg = run_config if run_config is not None else self.run_config
            async with AsyncSqliteSaver.from_conn_string(self.checkpointer_path) as checkpointer:
                # Compile graph if not already done
                if self.graph is None:
                    self.build()
                
                # Compile with checkpointer and stream
                self.graph = self.graph.compile(checkpointer=checkpointer)
                async for chunk in self.graph.astream(payload, config=cfg, stream_mode=self.stream_mode):
                    if isinstance(chunk, (str, bytes)):
                        yield chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                    else:
                        yield ("data: " + json.dumps(chunk) + "\n\n").encode("utf-8")
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            return
        except Exception as exc:  # noqa: BLE001
            yield self._encode_run_error(exc)



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
    # Checkpoint helpers
    # ---------------------------------------------------------------------
    def checkpoints_db_path(self) -> str:
        """Return the filesystem path where checkpoints will be stored."""
        agent_dir = Path("/app/checkpoints") / "langgraph" / self.name.strip()
        agent_dir.mkdir(parents=True, exist_ok=True)
        return str(agent_dir / "checkpoints.db")



    # ---------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------
    def _validate_config(self, config: ConfigSource) -> Dict[str, Any]:
        """Validate and normalise a config mapping coming from the UI - Backend."""
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



    # ---------------------------------------------------------------------
    # Error handling & SSE encoding
    # ---------------------------------------------------------------------
    @staticmethod
    def _format_run_error_message(exc: BaseException) -> str:
        """Create a verbose error description suitable for RUN_ERROR frames."""
        tb = traceback.format_exc()
        if tb and tb.strip() and tb.strip() != "NoneType: None":
            return tb.strip()
        return f"{type(exc).__name__}: {exc}"


    @classmethod
    def _encode_run_error(cls, exc: BaseException) -> bytes:
        """Return an SSE-formatted RUN_ERROR frame."""
        err = {"type": "RUN_ERROR", "message": cls._format_run_error_message(exc)}
        return ("data: " + json.dumps(err) + "\n\n").encode("utf-8")
