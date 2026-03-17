import asyncio
from typing import Any, List, Mapping, Optional, Literal, Sequence, Set
from abc import abstractmethod, ABC

from langgraph.checkpoint.memory import MemorySaver

from agui import AGUIEmitter, AGUIStreamNormalizer
from blueprints.base_agent import BaseAgent


STREAMING_MODES = Literal["updates", "messages"]
SubAgentsT = Sequence[Any] | Mapping[str, Any] | None

RESERVED_DEEPAGENT_TOOL_NAMES: Set[str] = {
    # planning
    "write_todos",
    
    # filesystem + execute
    "ls",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "execute",
    
    # delegation
    "task",
}

class DeepAgent(BaseAgent, ABC):
    
    # Default streaming mode for LangGraph inference
    stream_mode: List[STREAMING_MODES] = ["messages", "updates"]
    
    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        # Configuration
        super().__init__(config=config)
        
        # Agent components
        self.memory_saver: MemorySaver = MemorySaver()
        self.sub_agents: SubAgentsT = None
        self.agent: Any = None
        
        # AGUI components
        self.agui_emitter: AGUIEmitter = AGUIEmitter()
        self.agui_normalizer: AGUIStreamNormalizer = AGUIStreamNormalizer(
            thread_id=self.run_config.get("configurable", {}).get("thread_id", "")
        )



    # ---------------------------------------------------------------------
    # Workflow lifecycle
    # ---------------------------------------------------------------------
    @abstractmethod
    def register_subagents(self) -> SubAgentsT:
        """Instantiate nested agents if any."""
        return


    @abstractmethod
    def register_agent(self) -> Any:
        """Instantiate the main agent."""
        return


    def build(self) -> None:
        """Build the DeepAgent by registering sub-agents and the main agent."""
        if self.agent is None:
            self.sub_agents = self.register_subagents()
            self.agent = self.register_agent()
        return



    # ---------------------------------------------------------------------
    # Streaming interface
    # ---------------------------------------------------------------------
    async def astream(self, payload: Mapping[str, Any]) -> Any:
        """Asynchronous generator that streams agent outputs in AG-UI format.

        Args:
            payload: Input mapping for the agent.
        Yields:
            Streamed chunks in AG-UI format.
        """
        try:
            # Ensure the agent is built
            self.build()

            # Stream deep-agent execution results.
            async for chunk in self.agent.astream(
                payload,
                config=self.run_config,
                stream_mode=self.stream_mode,
                subgraphs=True,
            ):
                if isinstance(chunk, (str, bytes)):
                    yield chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                else:
                    for agui_event in self.agui_normalizer.handle_chunk(chunk):
                        yield agui_event
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            return
        except Exception as exc:
            yield self._encode_run_error(exc)



    # ---------------------------------------------------------------------
    # Tool management
    # ---------------------------------------------------------------------
    def _apply_live_tools(self, tools: Sequence[Any]) -> None:
        """
        Attach live MCP tools while excluding names reserved by deep-agent internals.
        Keeps BaseAgent behavior via super() after filtering.
        """
        reserved_names = {name.strip().lower() for name in RESERVED_DEEPAGENT_TOOL_NAMES}
        filtered_tools: list[Any] = []
        excluded_names: list[str] = []

        for tool in tools:
            raw_name = getattr(tool, "name", "")
            tool_name = raw_name.strip() if isinstance(raw_name, str) else str(raw_name or "").strip()
            if tool_name.lower() in reserved_names:
                excluded_names.append(tool_name)
                continue
            filtered_tools.append(tool)

        if excluded_names:
            print(
                f"[MCP tools] DeepAgent '{self.name}' excluded reserved tools: "
                f"{sorted(set(excluded_names))}"
            )

        super()._apply_live_tools(filtered_tools)
