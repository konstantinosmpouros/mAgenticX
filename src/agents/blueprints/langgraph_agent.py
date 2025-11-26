import asyncio
import json
from uuid import uuid4
import traceback
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Type
from pydantic import BaseModel

from langgraph.graph import StateGraph
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langchain_mcp_adapters.tools import load_mcp_tools

from agui import AGUIEmitter
from utils import (
    build_tool_cache_key,
    mcp_session_context,
)

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

    tool_registry: Sequence[Any] = ()

    def __init__(self, *, config: Optional[Mapping[str, Any]] = None,
    ) -> None:
        # Configuration
        self.config: Dict[str, Any] = self._validate_config(config) if config else {}
        
        # Runtime configuration
        default_run_config: Dict[str, Any] = {'configurable': {"thread_id": str(uuid4())}}
        self.run_config: Optional[Mapping[str, Any]] = self.config.get("run_config", default_run_config)
        
        # Configured tool selectors
        self.config_tools: Sequence[Mapping[str, Any]] = self.config.get("tools", [])
        self.config_tool_names: List[str] = (
            [self._build_tool_key_from_config(item) for item in self.config_tools] if self.config_tools else []
        )
        
        # Resolved tools (populated per-stream after loading from MCP)
        self.tools: List[Any] = []
        self.tools_names: List[str] = []
        
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


    def _ensure_built(self) -> None:
        """Ensure the agent's graph has been built."""
        if self.graph is None:
            self.build()



    # ---------------------------------------------------------------------
    # Async inference function
    # ---------------------------------------------------------------------
    async def astream(self, payload: Mapping[str, Any]) -> Any:
        """Stream LangGraph chunks as SSE bytes using the configured stream mode."""
        try:
            async with mcp_session_context() as session:
                live_tools = await load_mcp_tools(session)
                filtered_tools = self._filter_live_tools(live_tools)
                self._apply_live_tools(filtered_tools)

                async with AsyncSqliteSaver.from_conn_string(self.checkpointer_path) as checkpointer:
                    # Compile graph if not already done
                    self._ensure_built()

                    # Compile with checkpointer and stream
                    self.graph = self.graph.compile(checkpointer=checkpointer)
                    async for chunk in self.graph.astream(payload, config=self.run_config, stream_mode=self.stream_mode):
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
    #TODO: The problem might be in the tool naming convention. Check how the tools are named in MCP and how we build the key here.
    @staticmethod
    def _build_tool_key_from_config(entry: Mapping[str, Any]) -> str:
        """Normalise a config entry into server_id/tool_name cache key form."""
        raw_name = entry.get("tool_name", "")
        raw_server = entry.get("server_id", "")
        tool_name = raw_name.strip() if isinstance(raw_name, str) else str(raw_name or "")
        server_id = raw_server.strip() if isinstance(raw_server, str) else str(raw_server or "")
        return build_tool_cache_key(server_id, tool_name)


    @staticmethod
    def _build_tool_key_from_tool_name(name: str) -> str:
        """Convert an MCP/adapter tool name into server_id/tool_name form."""
        if "_" in name:
            server_id, tool_name = name.split("_", 1)
        else:
            server_id, tool_name = "", name
        return build_tool_cache_key(server_id, tool_name)


    def _filter_live_tools(self, tools: Sequence[Any]) -> List[Any]:
        """Return live LangChain tools filtered by configured server/tool keys."""
        if not self.config_tool_names:
            return []

        desired = set(self.config_tool_names)
        resolved: list[Any] = []
        seen: set[str] = set()

        for tool in tools:
            name = getattr(tool, "name", "") or ""
            key = self._build_tool_key_from_tool_name(str(name))
            if key in desired and key not in seen:
                resolved.append(tool)
                seen.add(key)

        missing = desired - seen
        if missing:
            print(f"[MCP tools] Agent '{self.name}' missing tools: {sorted(missing)}")

        print(f"[MCP tools] Agent '{self.name}' resolved tools: {sorted(seen)}")
        return resolved


    def _apply_live_tools(self, tools: Sequence[Any]) -> None:
        """Attach filtered live tools and rebuild agent components for this run."""
        self.tools = list(tools)
        self.tools_names = [getattr(tool, "name", "") for tool in self.tools]

        # Force rebuild of agents/nodes/graph with the live tool set.
        self.agents = None
        self.nodes = None
        self.graph = None



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
    def _validate_config(self, config: Mapping[str, Any]) -> Dict[str, Any]:
        """Validate and normalise a config mapping coming from the UI - Backend."""
        # Validate tool entries
        tools = config.get("tools")
        if tools is not None:
            if isinstance(tools, str) or not isinstance(tools, Sequence):
                raise TypeError("Agent config 'tools' must be a list of tool mappings.")
            config["tools"] = self._validate_tool_entries(tools)
        
        return config


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

            # Normalise optional server identifier
            raw_server = candidate.get("server_id", "")
            if raw_server is None:
                raw_server = ""
            if not isinstance(raw_server, str):
                raw_server = str(raw_server)
            candidate["server_id"] = raw_server.strip()
            
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
