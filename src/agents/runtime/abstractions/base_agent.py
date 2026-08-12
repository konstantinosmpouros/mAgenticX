from uuid import uuid4
from typing import Any, Dict, List, Literal, Mapping, Optional, Sequence

from core.error_handling import agent_stream_error_handler
from observability import get_logger
from runtime.personalization import Personalization, parse_personalization
from utils import (
    build_tool_cache_key,
    get_tool_cache_key,
)

logger = get_logger(__name__)


# The closed set of agent lifecycle types. The bridge persists this string
# verbatim in ``agents.type`` and the UI keys off it (e.g. the per-user skill
# selection panel renders only for ``"deep agent"``). Subclasses MUST set this
# to one of these literals — DeepAgent narrows it to ``"deep agent"`` at the
# base class level so concrete subclasses inherit the correct value.
AgentType = Literal["deep agent", "langgraph agent"]


class BaseAgent:
    """
    Base plumbing for agent templates shared by LangGraph/OpenAI variants.

    Centralizes config validation, tool selection, and metadata so subclasses can
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
    type: AgentType = "langgraph agent"
    description: Optional[str] = None
    icon: Optional[str] = None


    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        # Configuration
        self.config: Dict[str, Any] = self._validate_config(config) if config else {}
        
        # Runtime configuration
        default_run_config: Dict[str, Any] = {'configurable': {"thread_id": str(uuid4())}}
        self.run_config: Optional[Mapping[str, Any]] = self.config.get("run_config", default_run_config)
        
        # Configured tool selectors. Tools are declared per agent, not per request:
        # a deep agent overrides these from its spec (see YamlDeepAgent), and the
        # platform no longer accepts a per-request tool list. The base therefore
        # seeds them empty instead of reading config["tools"].
        self.config_tools: Sequence[Mapping[str, Any]] = []
        self.config_tool_names: List[str] = []
        
        # Resolved tools (populated per-stream after loading from MCP)
        self.tools: List[Any] = []
        self.tools_names: List[str] = []
        
        # Resolve context parameters from config
        self.context: Dict[str, Any] = self.config.get("context", {})

        # Per-run memory toggle, parsed from the run context (threaded from the
        # user's `use_memory` preference by the bridge). On by default so an
        # agent invoked without the flag keeps its always-on memory. Deep agents
        # read this to include or omit their persistent-memory wiring.
        self.use_memory: bool = bool(self.context.get("use_memory", True))

        # Per-run personalization (personality preset + custom instructions),
        # threaded from the user's preferences by the bridge and re-validated
        # fail-closed here. Neutral default when absent — `has_effect` False
        # leaves the agent's prompt untouched. Deep agents append the composed
        # block to their system prompt; LangGraph agents may adopt it later.
        self.personalization: Personalization = parse_personalization(self.context)



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
            logger.warning("agent_tools_missing", "Configured tools were not found in live MCP tools", agent_slug=self.name, missing_tools=sorted(missing))

        logger.info(
            "agent_tools_resolved",
            "Resolved configured MCP tools for agent",
            agent_slug=self.name,
            resolved_tools=sorted(seen),
            requested_tools=len(desired),
            resolved_count=len(seen),
        )
        return resolved


    def _apply_live_tools(self, tools: Sequence[Any]) -> None:
        """Attach filtered live tools and invalidate any cached agent state."""
        self.tools.extend(list(tools))
        self.tools_names = [getattr(tool, "name", "") for tool in self.tools]



    # ---------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------
    def _validate_config(self, config: Mapping[str, Any]) -> Dict[str, Any]:
        """Validate and normalise a config mapping coming from the UI/backend."""
        # Validate run config
        run_config = config.get("run_config")
        if run_config is not None:
            config["run_config"] = self._validate_run_config(run_config)

        # Validate context
        context = config.get("context")
        if context is not None:
            config["context"] = self._validate_context_config(context)

        return config


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


    @staticmethod
    def _validate_context_config(context: Mapping[str, Any]) -> Dict[str, Any]:
        """Validate and normalise the context mapping coming from the UI/backend."""
        if not isinstance(context, Mapping):
            raise TypeError("Agent config 'context' must be a mapping.")
        normalised = dict(context)
        for key in ("user_id", "conversation_id"):
            val = normalised.get(key)
            if val is None or not isinstance(val, str) or not val.strip():
                raise ValueError(f"Agent config 'context' must include a non-empty '{key}' string.")
            normalised[key] = val.strip()
        return normalised



    # ---------------------------------------------------------------------
    # Error handling & SSE encoding
    # ---------------------------------------------------------------------
    @classmethod
    def _encode_run_error(cls, exc: BaseException) -> bytes:
        """Log the traceback and return a clean SSE RUN_ERROR frame."""
        return agent_stream_error_handler.encode_run_error(logger, exc, agent_slug=cls.name)
