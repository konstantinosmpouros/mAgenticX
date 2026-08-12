import asyncio
from typing import Any, Mapping, Optional, Type, Literal
from abc import abstractmethod, ABC
from pydantic import BaseModel

from langgraph.graph import StateGraph
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from runtime.agui import AGUIEmitter, AGUIStreamNormalizer
from runtime.abstractions.base_agent import BaseAgent
from runtime.checkpointer import get_checkpointer
from observability import get_logger

logger = get_logger(__name__)

STREAMING_MODES = Literal["custom"] | list[Literal["messages", "updates"]]

class LangGraphAgent(BaseAgent, ABC):
    """
    LangGraph-specific base that compiles a ``StateGraph`` and streams results.

    Extends ``BaseAgent`` with AG-UI emitters/normalizers, optional in-memory
    checkpointing for HITL runs, and a simple lifecycle for assembling graphs.

    Subclasses override the registration hooks to initialise chains (agents),
    node callables, and edges before the graph is compiled. ``astream()`` builds
    on demand, forwards LangGraph chunks into AGUI's streaming format, and
    surfaces interrupts as HITL payloads when present.
    """

    # Default streaming mode for LangGraph inference
    stream_mode: STREAMING_MODES = "custom"

    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        # Configuration
        super().__init__(config=config)
        
        # Agent components
        self.state: Type[BaseModel] | None = None
        self.agents: Any = None
        self.nodes: Any = None
        self.graph = None
        self.memory_saver: InMemorySaver | None = None  # created lazily at build time
        
        # AGUI components. The normalizer stamps AG-UI message_id + keys its
        # sub-agent namespace bindings on the per-RUN id (the assistant message
        # id), NOT the checkpointer thread_id — which is now branch-scoped and
        # shared across a branch's runs. Read run_id from context; fall back to
        # the LangGraph thread_id for thread-less / legacy callers.
        self.agui_emitter: AGUIEmitter = AGUIEmitter()
        self.agui_normalizer: AGUIStreamNormalizer = AGUIStreamNormalizer(
            thread_id=self.context.get("run_id")
            or self.run_config.get("configurable", {}).get("thread_id", "")
        )



    # ---------------------------------------------------------------------
    # Graph/Workflow lifecycle
    # ---------------------------------------------------------------------
    @abstractmethod
    def register_agents(self) -> None:
        """Instantiate LLM chains/helpers and store them on ``self.agents``."""
        return


    @abstractmethod
    def register_nodes(self) -> None:
        """Create node callables (usually closing over ``self.agents``/``self.agui``)."""
        return


    def register_agents_and_nodes(self) -> None:
        """
        Initialise agents then nodes once per template instance.
        
        Automatically invoked by ``build()`` before any graph wiring occurs. If
        both components are already initialized it becomes a no-op.
        """
        if self.agents is not None and self.nodes is not None:
            return
        self.agents = self.register_agents()
        self.nodes = self.register_nodes()


    @abstractmethod
    def register_graph_nodes(self, graph: StateGraph) -> None:
        """Attach node handlers to the provided graph instance."""
        return


    @abstractmethod
    def register_graph_edges(self, graph: StateGraph) -> None:
        """Connect graph nodes with edges or conditional routes."""
        return


    def build(self) -> None:
        """
        Build or rebuild the LangGraph ``StateGraph`` for this agent instance.

        Invokes the three registration hooks in order to assemble the graph and
        compiles it with the per-thread checkpointer when HITL is enabled. If
        ``self.memory_saver`` was preset by :meth:`ensure_built` (rehydrated
        from the thread-keyed cache so a resume request can pick up a paused
        checkpoint) we keep it; otherwise an ephemeral saver is created for
        this instance. Invoked automatically by ``ensure_built()``; when no
        ``state`` is defined, ``self.agents`` is returned directly.
        """
        if self.graph is None:
            logger.info("langgraph_build_started", "LangGraph build started", agent_slug=self.name)
            if self.memory_saver is None:
                self.memory_saver = InMemorySaver()
            self.register_agents_and_nodes()

            if self.state is None and self.nodes is None:
                self.graph = self.agents
            else:
                graph = StateGraph(self.state)
                graph = self.register_graph_nodes(graph)
                graph = self.register_graph_edges(graph)
                self.graph = graph.compile(checkpointer=self.memory_saver)
            logger.info("langgraph_build_completed", "LangGraph build completed", agent_slug=self.name)
        return


    # ---------------------------------------------------------------------
    # Public lifecycle helpers (used by ``astream`` and HITL resume)
    # ---------------------------------------------------------------------
    async def ensure_built(self) -> None:
        """Rehydrate the per-thread checkpointer from cache and build the graph.

        Idempotent: safe to call multiple times. The HITL ``/resume`` endpoint
        invokes this directly so it can read ``self.compiled.get_state(...)``
        before issuing the resume command; ``astream`` also calls it to share
        the same cache-then-build path.
        """
        thread_id = self.run_config.get("configurable", {}).get("thread_id") or ""
        if self.memory_saver is None and thread_id:
            # Bind the process-wide durable saver. The thread is selected at
            # astream time via config=self.run_config — one shared saver, many
            # threads. Thread-less runs fall back to an ephemeral InMemorySaver
            # in build().
            self.memory_saver = get_checkpointer()
        self.build()


    @property
    def compiled(self) -> Any:
        """The compiled runnable produced by ``build()``. ``None`` until built."""
        return self.graph



    # ---------------------------------------------------------------------
    # Async inference function
    # ---------------------------------------------------------------------
    async def astream(self, payload: Mapping[str, Any], *, command: Optional[Command] = None) -> Any:
        """
        Stream LangGraph chunks as SSE bytes using the configured stream mode.

        Builds the graph on demand, routes interrupts to AG-UI HITL frames, and
        normalizes other chunks through ``self.agui_normalizer`` before yielding.
        Args:
            payload: Input mapping for the graph execution.
            command: Optional ``langgraph.types.Command``. When provided it is
                fed to the graph in place of ``payload`` so a previously paused
                HITL run can be resumed from its saved checkpoint.
        Yields:
            Streamed chunks in AG-UI format.
        """
        try:
            await self.ensure_built()
            logger.info(
                "langgraph_execution_started",
                "LangGraph execution started",
                agent_slug=self.name,
                stream_mode=self.stream_mode,
                resumed=command is not None,
            )

            graph_input: Any = command if command is not None else payload
            # Stream graph execution results
            async for chunk in self.graph.astream(
                graph_input,
                config=self.run_config,
                stream_mode=self.stream_mode
            ):
                if isinstance(chunk, (str, bytes)):
                    yield chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                else:
                    for agui_event in self.agui_normalizer.handle_chunk(chunk):
                        yield agui_event
            logger.info("langgraph_execution_completed", "LangGraph execution completed", agent_slug=self.name)
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            logger.info("langgraph_execution_cancelled", "LangGraph execution cancelled", agent_slug=self.name)
            return
        except Exception as exc:
            yield self._encode_run_error(exc)


