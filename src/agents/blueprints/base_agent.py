import json
from uuid import uuid4
import traceback
from typing import Any, Dict, List, Mapping, Optional, Sequence, Literal

from utils import (
    build_tool_cache_key,
    get_tool_cache_key,
)


class BaseAgent:
    """
    Base plumbing for agent templates shared by LangGraph/OpenAI variants.

    Centralises config validation, tool selection, and metadata so subclasses can
    focus on execution logic or graph wiring.

    Provides:
        • Normalised config coming from UI/backend (tools + run_config)
        • Cache-key based filtering of live MCP tools before each run
        • Reset of agent/node/graph caches when tools change
        • Class-level manifest/metadata for registries and UI surfaces
        • Error formatting helpers that emit SSE-friendly RUN_ERROR frames

    Streaming/execution is defined by subclasses (see ``LangGraphAgent``) which
    call into these helpers to stay consistent across agents.
    """

    # Stable slug used for registry lookups and URL routing
    name: str = "base-agent"

    # Human-readable identifiers exposed to downstream consumers
    agent_id: str = "base-agent"
    label: str = "Base Agent"
    version: str = "0.0.1"
    type: Literal["langgraph agent", "openai agent"] = "langgraph agent"
    description: Optional[str] = None
    icon: Optional[str] = None


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



    # ---------------------------------------------------------------------
    # Metadata & utilities
    # ---------------------------------------------------------------------
    @property
    def metadata(self) -> Dict[str, Any]:
        """Expose the class-level manifest for this concrete agent instance."""
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
    # Tool management
    # ---------------------------------------------------------------------
    def attach_tools(self, live_tools: Sequence[Any]) -> None:
        """Filter and attach externally provided MCP tools for the next run."""
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
        """Filter live LangChain tools against configured server/tool keys."""
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
        """Attach filtered live tools and invalidate any cached agent state."""
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
        """Validate and normalise a config mapping coming from the UI/backend."""
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
