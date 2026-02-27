import asyncio
from abc import ABC, abstractmethod
from typing import Any, Literal, Mapping, Optional, Sequence, Set

from langgraph.checkpoint.memory import MemorySaver

from agui import AGUIEmitter, AGUIStreamNormalizer
from blueprints.base_agent import BaseAgent


STREAMING_MODES = Literal["updates", "messages"]
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
    """
    Deep-agent blueprint with explicit lifecycle hooks and AG-UI normalization.

    Subclasses hardcode deep-agent behavior (model, sub-agents, HITL options,
    interrupt_before/after) in ``register_subagents()`` and ``register_agent()``.
    The runtime config remains focused on base concerns (tools/run_config).
    """

    stream_mode: list[STREAMING_MODES] = ["messages", "updates"]

    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(config=config)

        # Agent components
        self.memory_saver: MemorySaver = MemorySaver()
        self.sub_agents: Any = None
        self.agent: Any = None

        # AGUI components
        thread_id = self.run_config.get("configurable", {}).get("thread_id", "")
        self.agui_emitter: AGUIEmitter = AGUIEmitter()
        self.agui_normalizer: AGUIStreamNormalizer = AGUIStreamNormalizer(thread_id=thread_id)

    # ---------------------------------------------------------------------
    # Workflow lifecycle
    # ---------------------------------------------------------------------
    @abstractmethod
    def register_subagents(self) -> Any:
        """Instantiate and return nested sub-agents."""
        return

    @abstractmethod
    def register_agent(self) -> Any:
        """Instantiate and return the main deep agent."""
        return

    def register_subagents_and_agent(self) -> None:
        """
        Initialise sub-agents then main agent once per instance.

        ``register_agent()`` can assume ``self.sub_agents`` has already been
        populated when called from this lifecycle.
        """
        if self.sub_agents is None:
            self.sub_agents = self.register_subagents()
        if self.agent is None:
            self.agent = self.register_agent()

    def build(self) -> None:
        """Build the deep agent lazily before execution."""
        if self.agent is None:
            self.register_subagents_and_agent()
        return

    # ---------------------------------------------------------------------
    # Tool management
    # ---------------------------------------------------------------------
    def _apply_live_tools(self, tools: Sequence[Any]) -> None:
        """
        Attach tools and invalidate deep-agent runtime caches.

        Called indirectly by ``attach_tools()`` in ``BaseAgent``.
        """
        super()._apply_live_tools(tools)
        self.sub_agents = None
        self.agent = None

    # ---------------------------------------------------------------------
    # Streaming interface
    # ---------------------------------------------------------------------
    async def astream(self, payload: Mapping[str, Any]) -> Any:
        """
        Stream deep-agent chunks as AG-UI SSE events.

        Args:
            payload: Input mapping for the deep-agent execution.
        Yields:
            Streamed chunks in AG-UI format.
        """
        try:
            self.build()

            async for chunk in self.agent.astream(
                payload,
                config=self.run_config,
                stream_mode=self.stream_mode,
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
