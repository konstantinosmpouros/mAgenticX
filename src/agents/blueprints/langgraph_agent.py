import asyncio
import json
import time
from uuid import uuid4
import traceback
from typing import Any, Dict, List, Mapping, Optional, Sequence, Type, Literal
from pydantic import BaseModel

from langgraph.graph import StateGraph
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.serde.types import INTERRUPT

from agui import AGUIEmitter, AGUIStreamNormalizer
from utils import (
    build_tool_cache_key,
    get_tool_cache_key,
)

STREAMING_MODES = Literal["custom", "updates", "messages"]

class LangGraphAgent:
    """
    Reusable template that wires LangGraph agents into the service runtime.

    Responsibilities shared by every subclass:
        • Normalised tool resolution driven by UI/back-end config
        • Dynamically rebuilt agents/nodes per-inference with live tools
        • MCP session management for tool loading and execution
        • A consistent AG-UI emitter for streaming thoughts/events
        • A build in lifecycle that registers nodes/edges then compiles the graph
        • In-memory checkpointing when ``use_checkpointer`` is enabled (HITL-ready)
        • An generic async ``astream()`` method for FastAPI and AGUI integration
        • Standardised metadata manifest for registry and discovery
        • Error handling and SSE encoding for run-time exceptions

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

    # Default streaming mode for LangGraph inference
    stream_mode: STREAMING_MODES = "custom"

    # Shared AG-UI emitter instance
    agui_emitter: AGUIEmitter = AGUIEmitter()
    agui_normalizer: AGUIStreamNormalizer = AGUIStreamNormalizer(emitter=agui_emitter, stream_mode=stream_mode)

    # Runtime options
    has_hitl: bool = False


    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
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
        
        # Agent components
        self.memory_saver: MemorySaver = MemorySaver() if self.has_hitl else None
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
        return


    def register_nodes(self) -> None:
        """Create node callables (usually closing over ``self.agents``/``self.agui``)."""
        return


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
        return


    def register_graph_edges(self, graph: StateGraph) -> None:
        """Connect graph nodes with edges or conditional routes."""
        return


    def build(self) -> None:
        """
        Build or rebuild the LangGraph ``StateGraph`` for this agent instance.
        Invokes the three registration hooks in order to assemble the graph.
        Returns the compiled ``StateGraph`` instance.
        
        Invoked automatically by ``astream()`` if the graph is not already built.
        If no state model is defined, the raw agents are returned instead.
        """
        if self.graph is None:
            self.register_agents_and_nodes()
        
            if self.state is None and self.nodes is None:
                self.graph = self.agents
            else:
                graph = StateGraph(self.state)
                self.register_graph_nodes(graph)
                self.register_graph_edges(graph)
                self.graph = graph.compile(checkpointer=self.memory_saver)
        return



    # ---------------------------------------------------------------------
    # Async inference function
    # ---------------------------------------------------------------------
    async def astream(self, payload: Mapping[str, Any]) -> Any:
        """Stream LangGraph chunks as SSE bytes using the configured stream mode."""
        try:
            # Build graph if not already done
            self.build()

            # Stream graph execution results
            async for chunk in self.graph.astream(
                payload,
                config=self.run_config,
                stream_mode=self.stream_mode
            ):
                if isinstance(chunk, dict) and INTERRUPT in chunk:
                    thread_id = self.run_config.get("configurable", {}).get("thread_id", "")
                    yield self.agui.hitl_interrupt(
                        thread_id=thread_id,
                        interrupt=chunk[INTERRUPT],
                    )
                elif isinstance(chunk, (str, bytes)):
                    yield chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                else:
                    for norm_chunk in self.agui_normalizer.handle_chunk(chunk):
                        yield norm_chunk
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            return
        except Exception as exc:
            yield self._encode_run_error(exc)



    # ---------------------------------------------------------------------
    # Tool management
    # ---------------------------------------------------------------------
    def attach_tools(self, live_tools: Sequence[Any]) -> None:
        """Filter and apply externally provided MCP tools."""
        self._apply_live_tools(self._filter_live_tools(live_tools))


    @staticmethod
    def _build_tool_key_from_config(entry: Mapping[str, Any]) -> str:
        """Normalise a config entry into server_id/tool_name cache key form."""
        raw_name = entry.get("tool_name", "")
        raw_server = entry.get("server_id", "")
        tool_name = raw_name.strip() if isinstance(raw_name, str) else str(raw_name or "")
        server_id = raw_server.strip() if isinstance(raw_server, str) else str(raw_server or "")
        return build_tool_cache_key(server_id, tool_name)


    def _filter_live_tools(self, tools: Sequence[Any]) -> List[Any]:
        """Return live LangChain tools filtered by configured server/tool keys."""
        if not self.config_tool_names:
            return []

        desired = set(self.config_tool_names)
        resolved: list[Any] = []
        seen: set[str] = set()

        for tool in tools:
            key = get_tool_cache_key(tool)
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
        self.tools.extend(list(tools))
        self.tools_names = [getattr(tool, "name", "") for tool in self.tools]

        # Force rebuild of agents/nodes/graph with the live tool set.
        self.agents = None
        self.nodes = None
        self.graph = None



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
            config["tools"] = self._validate_tool_config(tools)

        # Validate run config
        run_config = config.get("run_config")
        if run_config is not None:
            config["run_config"] = self._validate_run_config(run_config)
        
        return config


    @staticmethod
    def _validate_tool_config(tools: Sequence[Any]) -> List[Mapping[str, Any]]:
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


    @staticmethod
    def _validate_run_config(run_config: Mapping[str, Any]) -> Dict[str, Any]:
        """Ensure run_config is a mapping and normalise nested configurable map."""
        if not isinstance(run_config, Mapping):
            raise TypeError("Agent config 'run_config' must be a mapping.")
        normalised = dict(run_config)
        configurable = normalised.get("configurable")
        if configurable is not None and not isinstance(configurable, Mapping):
            raise TypeError("Agent run_config 'configurable' must be a mapping.")
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
