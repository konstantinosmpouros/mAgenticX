import asyncio
import inspect
from pathlib import Path
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

    # filesystem
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
    Blueprint for deep/autonomous agents.

    Extends ``BaseAgent`` with a structured build lifecycle and convention-based
    asset discovery.  Subclasses only need to implement ``register_agent()``;
    every other hook has a sensible default so the constructor never needs to be
    touched.

    Build lifecycle (invoked automatically by ``astream()`` on first run):

        load_skills()        → self.skills_paths   (auto-discovered: ["./skills/"])
        load_memory()        → self.memory          (long-term memory store, if any)
        load_agent_md()      → self.agent_md_paths  (auto-discovered: ["./AGENT.md"])
        register_subagents() → self.sub_agents       (nested agents, if any)
        register_agent()  ★  → self.agent            (the final runnable)

    Convention-based asset discovery (all paths relative to the concrete
    subclass file, resolved via inspect at runtime):

        <impl_dir>/AGENT.md      — agent instructions file  (→ self.agent_md_paths)
        <impl_dir>/skills/       — skill subdirectories      (→ self.skills_paths)
        <impl_dir>/store/        — persistent file workspace (→ self.store_dir)
        <impl_dir>/memory/       — long-term memory root     (→ self.memory_dir)

    Skills follow the ``skills/<name>/SKILL.md`` convention expected by
    ``create_deep_agent(skills=[...])``.  Each skill is a subdirectory
    containing at least a ``SKILL.md`` file (frontmatter + instructions).

    Pass the discovered paths to ``create_deep_agent`` inside ``register_agent()``:

        create_deep_agent(
            memory=self.agent_md_paths,   # MemoryMiddleware — always-on context
            skills=self.skills_paths,     # SkillsMiddleware — progressive disclosure
            backend=...,                  # your choice: FilesystemBackend, StoreBackend, …
            ...
        )

    Checkpointing:
        ``self.checkpointer`` is a fresh ephemeral ``InMemorySaver`` created at
        build time.  Pass it to ``create_deep_agent`` inside ``register_agent()``
        when HITL is needed.  It lives only as long as the agent object (one
        per request) and is garbage-collected automatically at request end.
    """

    # Default streaming mode
    stream_mode: List[STREAMING_MODES] = ["messages", "updates"]

    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(config=config)

        # Directory of the concrete subclass file — source assets live here
        self._impl_dir: Path = Path(inspect.getfile(type(self))).parent

        # Agent components — all populated during build()
        self.skills_paths: list[str] = []       # absolute path to skills/ — for create_deep_agent(skills=[...])
        self.agent_md_paths: list[str] = []     # absolute path to AGENT.md — for create_deep_agent(memory=[...])
        self.memory: Any = None
        self.checkpointer: MemorySaver | None = MemorySaver()  # ephemeral, GC'd at request end
        self.sub_agents: SubAgentsT = None
        self.agent: Any = None

        # AGUI components
        self.agui_emitter: AGUIEmitter = AGUIEmitter()
        self.agui_normalizer: AGUIStreamNormalizer = AGUIStreamNormalizer(
            thread_id=self.run_config.get("configurable", {}).get("thread_id", "")
        )



    # ---------------------------------------------------------------------
    # Persistent path properties
    # ---------------------------------------------------------------------
    @property
    def filesystem_dir(self) -> Path:
        """Root dir for the FilesystemBackend — all files the agent creates go here."""
        path = self._impl_dir / "filesystem"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def store_dir(self) -> Path:
        """Persistent file workspace: ``<impl_dir>/store/``."""
        path = self._impl_dir / "store"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def memory_dir(self) -> Path:
        """Long-term memory root: ``<impl_dir>/memory/``."""
        path = self._impl_dir / "memory"
        path.mkdir(parents=True, exist_ok=True)
        return path



    # ---------------------------------------------------------------------
    # Lifecycle hooks
    # ---------------------------------------------------------------------
    def load_skills(self) -> list[str]:
        """Auto-discover skills directory. Returns relative path (resolved against backend root_dir=_impl_dir)."""
        if not (self._impl_dir / "skills").exists():
            return []
        return ["./skills/"]


    def load_memory(self) -> Any:
        """
        Override to open and return a long-term memory store for this agent.

        Use ``self.memory_dir`` as the root path.  The returned value is stored
        on ``self.memory`` before ``register_agent()`` is called.
        """
        return None


    def load_agent_md(self) -> list[str]:
        """Auto-discover AGENT.md. Returns relative path (resolved against backend root_dir=_impl_dir)."""
        if (self._impl_dir / "AGENT.md").exists():
            return ["./AGENT.md"]
        return []


    def register_subagents(self) -> SubAgentsT:
        """Override to instantiate nested sub-agents."""
        return None


    @abstractmethod
    def register_agent(self) -> Any:
        """
        Build and return the main agent runnable.

        All lifecycle state is populated before this is called:
            self.skills_paths    — paths for create_deep_agent(skills=[...])
            self.agent_md_paths  — paths for create_deep_agent(memory=[...])
            self.memory          — long-term memory store (or None)
            self.checkpointer    — ephemeral InMemorySaver for HITL
            self.sub_agents      — nested agents (or None)
            self.tools           — filtered live MCP tools

        Minimal example::

            def register_agent(self) -> Any:
                return create_deep_agent(
                    tools=self.tools,
                    memory=self.agent_md_paths,
                    skills=self.skills_paths,
                    subagents=self.sub_agents,
                    checkpointer=self.checkpointer,
                    backend=FilesystemBackend(root_dir=self._impl_dir, virtual_mode=True),
                )
        """
        return None



    # ---------------------------------------------------------------------
    # Build
    # ---------------------------------------------------------------------
    def build(self) -> None:
        """Invoke lifecycle hooks in order and assemble the agent."""
        if self.agent is None:
            self.skills_paths   = self.load_skills()
            self.memory         = self.load_memory()
            self.agent_md_paths = self.load_agent_md()
            self.sub_agents     = self.register_subagents()
            self.agent          = self.register_agent()



    # ---------------------------------------------------------------------
    # Streaming interface
    # ---------------------------------------------------------------------
    async def astream(self, payload: Mapping[str, Any]) -> Any:
        """
        Build on demand and stream agent outputs in AG-UI format.

        Args:
            payload: Input mapping for the agent. Expected key: ``messages``.
        Yields:
            Streamed SSE bytes in AG-UI format.
        """
        try:
            self.build()

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
        filtered_tools: List[Any] = []
        excluded_names: List[str] = []

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
