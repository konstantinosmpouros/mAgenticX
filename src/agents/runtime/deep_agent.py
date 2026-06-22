import asyncio
import inspect
from pathlib import Path
from typing import Any, Callable, List, Mapping, Optional, Literal, Sequence, Set
from abc import abstractmethod, ABC

from deepagents import create_deep_agent, FilesystemPermission
from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from runtime.agui import AGUIEmitter, AGUIStreamNormalizer
from runtime.base_agent import AgentType, BaseAgent
from runtime.checkpointer import get_checkpointer
from runtime.tool_error_middleware import ToolErrorMiddleware
from runtime.filesystem import (
    conversation_root as _conversation_root,
    ensure_user_agent_filesystem,
    memory_root as _memory_root,
    skills_root as _skills_root,
)
from observability import get_logger

logger = get_logger(__name__)

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

    # Override BaseAgent default — every concrete subclass of ``DeepAgent``
    # IS a deep agent. The bridge persists this in ``agents.type`` and the UI
    # filters by it to show the per-user skill selection panel only here.
    type: AgentType = "deep agent"

    # Static behaviour contract — concrete subclasses override the
    # ``instructions`` string with their personality / orchestration prompt
    # passed to ``create_deep_agent(system_prompt=...)``. Skill assignments
    # are no longer seeded from the deep-agent class — they're owned by the
    # user's pool (see ``runtime.skill_registry.user_registry``) and a fresh
    # user's pool starts empty until they explicitly add skills via the UI.
    instructions: str = ""

    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(config=config)

        # Directory of the concrete subclass file — source assets live here
        self._impl_dir: Path = Path(inspect.getfile(type(self))).parent

        # Per-request cache for the resolved per-user filesystem root. Set on
        # first build call to avoid restating the directory across the
        # ``load_skills`` / ``load_agent_md`` / ``register_agent`` hooks.
        self._user_filesystem_root: Optional[Path] = None

        # Agent components — all populated during build()
        self.skills_paths: list[str] = []       # absolute path to skills/ — for create_deep_agent(skills=[...])
        self.agent_md_paths: list[str] = []     # absolute path to AGENT.md — for create_deep_agent(memory=[...])
        self.memory: Any = None
        # Lazy: created (or rehydrated from the thread-keyed cache) inside
        # astream() so a HITL resume request picks up the paused checkpoint
        # instead of starting a fresh saver every request.
        self.checkpointer: MemorySaver | None = None
        self.sub_agents: SubAgentsT = None
        self.agent: Any = None

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
    # Per-user filesystem resolution
    # ---------------------------------------------------------------------
    def _resolve_user_filesystem_root(self) -> Path:
        """Provision (idempotently) and return ``<filesystem_root>/<user_id>/``.

        Reads ``user_id`` and ``conversation_id`` from ``self.context`` — the
        bridge stamps both on every request, and
        ``BaseAgent._validate_context_config`` rejects payloads that omit
        either. The first call for a (user, agent) pair seeds ``AGENT.md``
        from the standard template; the skills directory is created empty
        (writes are owned by the skill-registry layer). The conversation
        directory is mkdir'd on every call but is a cheap no-op when it
        already exists.
        """
        if self._user_filesystem_root is not None:
            return self._user_filesystem_root
        ctx = self.context or {}
        user_id = ctx.get("user_id")
        if not user_id:
            raise ValueError(
                "Deep agent requires a non-empty user_id in context to provision its filesystem."
            )
        conversation_id = ctx.get("conversation_id")
        self._user_filesystem_root = ensure_user_agent_filesystem(
            user_id=user_id,
            agent_slug=self.name,
            conversation_id=conversation_id,
        )
        return self._user_filesystem_root


    def _build_composite_backend(
        self,
    ) -> Callable[[Any], CompositeBackend]:
        """Return a factory that mints a fresh ``CompositeBackend`` per tool call.

        The deepagents library accepts ``backend=callable(ToolRuntime) -> Backend``
        and invokes it on every tool call so ``StateBackend`` can bind to the
        live runtime. Three FilesystemBackends are mounted at structurally
        disjoint roots so no route can resolve into another's tree:

            /memories/            → <user_root>/memory/                       (AGENT.md only)
            /skills/              → <user_root>/agents/<self.name>/skills/    (user-enabled skills)
            /conversation/input/  → <conv_id>/input/                          (user uploads, read-only)
            /conversation/output/ → <conv_id>/output/                         (agent artifacts, read-write)
            /conversation/        → <user_root>/agents/<self.name>/<conv_id>/ (this chat only)
            default               → StateBackend(rt)                          (ephemeral scratch)

        Per-conversation isolation: ``/conversation/`` is rooted at a
        single ``<conv_id>`` directory, so files written in one chat are
        not visible from the next. The agent persists durable
        cross-conversation context by editing ``/memories/AGENT.md``
        directly. ``input/`` holds user-uploaded files (the bridge seeds them
        before each run and the agent reads them on demand — write-denied);
        ``output/`` is where the agent writes generated artifacts. Both are
        subdirs of ``<conv_id>`` so they also surface under ``/conversation/``;
        the dedicated longer-prefix routes give the write-deny a clean target.

        The central skills registry is intentionally **not mounted**. It is
        a user-facing catalogue browsed via the ProfilePanel Skills tab —
        the agent only ever sees the skills the user has explicitly
        enabled, which arrive on disk via the bridge's PUT endpoint
        copying registry directories into ``skills/``.
        """
        self._resolve_user_filesystem_root()  # ensure tree exists
        ctx = self.context
        user_id = ctx["user_id"]
        conversation_id = ctx["conversation_id"]
        memory_path = _memory_root(user_id)
        skills_path = _skills_root(user_id, self.name)
        conv_path = _conversation_root(user_id, self.name, conversation_id)
        # Per-conversation, on-disk homes for deepagents' offloaded artifacts.
        # Created eagerly so `ls` works before the first offload write.
        large_tool_results_path = conv_path / "large_tool_results"
        conversation_history_path = conv_path / "conversation_history"
        large_tool_results_path.mkdir(parents=True, exist_ok=True)
        conversation_history_path.mkdir(parents=True, exist_ok=True)
        # input/ (read-only user uploads, seeded by the bridge) + output/
        # (read-write agent artifacts). Subdirs of conv_path → longer-prefix
        # routes win over the /conversation/ mount they overlap.
        input_path = conv_path / "input"
        output_path = conv_path / "output"
        input_path.mkdir(parents=True, exist_ok=True)
        output_path.mkdir(parents=True, exist_ok=True)

        def factory(rt: Any) -> CompositeBackend:
            return CompositeBackend(
                default=StateBackend(),
                routes={
                    "/memories/": FilesystemBackend(
                        root_dir=str(memory_path), virtual_mode=True
                    ),
                    "/skills/": FilesystemBackend(
                        root_dir=str(skills_path), virtual_mode=True
                    ),
                    "/conversation/input/": FilesystemBackend(
                        root_dir=str(input_path), virtual_mode=True
                    ),
                    "/conversation/output/": FilesystemBackend(
                        root_dir=str(output_path), virtual_mode=True
                    ),
                    "/conversation/": FilesystemBackend(
                        root_dir=str(conv_path), virtual_mode=True
                    ),
                    # deepagents offloads to the top-level /large_tool_results/ and
                    # /conversation_history/ prefixes (default artifacts_root="/").
                    # Route them to per-conversation disk so they persist instead
                    # of living on the ephemeral StateBackend default. These dirs
                    # sit inside the conversation dir, so they are also reachable
                    # under /conversation/ — a cosmetic overlap the planned
                    # input/output restructure will remove.
                    "/large_tool_results/": FilesystemBackend(
                        root_dir=str(large_tool_results_path), virtual_mode=True
                    ),
                    "/conversation_history/": FilesystemBackend(
                        root_dir=str(conversation_history_path), virtual_mode=True
                    ),
                },
            )

        return factory


    def _build_workspace_permissions(self) -> list[FilesystemPermission]:
        """Explicit write-deny rules over the built-in filesystem tools, shared by
        every deep agent (defined here in the base, never per-agent).

        Confinement is primarily structural: the CompositeBackend routes every
        path to a per-(user, agent, conversation) FilesystemBackend or the
        ephemeral, agent-scoped StateBackend, none of which can reach the host or
        another user (``virtual_mode`` blocks ``..``/absolute-path escapes). On
        top of that, these rules make the agent-facing surface explicitly
        read-only where it should never write:

        - ``/skills/`` — the user manages the skill library via the UI.
        - ``/large_tool_results/`` and ``/conversation_history/`` —
          deepagents-managed bookkeeping (offload eviction + archive). The model
          may READ offloaded results but must not write/tamper with them; the
          library's own offload writes go through the backend, not these tools,
          so they are unaffected.

        - ``/conversation/input/`` — user uploads are read-only; the agent
          writes generated artifacts to ``/conversation/output/`` instead.

        Writes stay open where the agent legitimately needs them —
        ``/conversation/output/`` and ``/conversation/`` (artifacts) and
        ``/memories/AGENT.md`` (durable memory). There is deliberately NO
        catch-all deny: a read-deny would block the agent from reading its
        offloaded ``/large_tool_results/`` or its uploaded ``/conversation/input/``.
        Every path must map to a mounted route (deepagents'
        ``_all_paths_scoped_to_routes`` guard); ``{,/**}`` matches the mount
        root, the root with a trailing slash, and everything beneath it.

        Caveat: deepagents does not yet support tool-level permissions once the
        backend provides command execution (``SandboxBackendProtocol``) — revisit
        this method when the execute tool is enabled.
        """
        return [
            FilesystemPermission(operations=["write"], paths=["/skills{,/**}"], mode="deny"),
            FilesystemPermission(operations=["write"], paths=["/large_tool_results{,/**}"], mode="deny"),
            FilesystemPermission(operations=["write"], paths=["/conversation_history{,/**}"], mode="deny"),
            # User uploads are read-only; the agent writes artifacts to
            # /conversation/output/ instead.
            FilesystemPermission(operations=["write"], paths=["/conversation/input{,/**}"], mode="deny"),
        ]


    @staticmethod
    def _inject_tool_error_middleware(subagents: SubAgentsT) -> SubAgentsT:
        """Prepend ToolErrorMiddleware to each sub-agent spec. The parent's
        ``create_deep_agent(middleware=...)`` does not reach sub-agents — they
        compile with only their own middleware list — so the policy has to be
        injected per spec here, keeping it owned by the base (concrete agents'
        ``register_subagents()`` stay untouched). Pre-compiled sub-agents (a
        ``runnable`` entry) can't take middleware and pass through unchanged.
        """
        if not isinstance(subagents, (list, tuple)):
            return subagents
        augmented: list[Any] = []
        for spec in subagents:
            if isinstance(spec, dict) and "runnable" not in spec:
                existing = list(spec.get("middleware") or [])
                augmented.append({**spec, "middleware": [ToolErrorMiddleware(), *existing]})
            else:
                augmented.append(spec)
        return augmented

    def build_deep_agent(
        self,
        *,
        model: Any,
        system_prompt: Any = None,
        subagents: SubAgentsT = None,
        interrupt_on: dict[str, Any] | None = None,
    ) -> Any:
        """Assemble the runnable with the fixed, plug-and-play filesystem wiring
        injected from the base — memory, skills, the per-(user, agent,
        conversation) CompositeBackend, and its permission ladder. These are
        identical for every deep agent; only the on-disk roots vary, computed
        per (user, agent, conversation) at tool-call time. Concrete agents call
        this from ``register_agent()`` and supply only what differs: model,
        system prompt, sub-agents, and HITL gating. Agent-specific tools come
        from ``self.tools`` (populate them via ``attach_tools()``).
        """
        return create_deep_agent(
            model=model,
            name=self.name,
            tools=self.tools,
            system_prompt=system_prompt,
            subagents=self._inject_tool_error_middleware(subagents),
            interrupt_on=interrupt_on,
            # A tool exception becomes an error ToolMessage instead of aborting
            # the run; injected into sub-agents too (see _inject_tool_error_middleware).
            middleware=[ToolErrorMiddleware()],
            # Fixed filesystem — same mounts + permissions for every deep agent.
            memory=self.agent_md_paths,
            skills=self.skills_paths,
            backend=self._build_composite_backend(),
            permissions=self._build_workspace_permissions(),
            context_schema=self.context,
            checkpointer=self.checkpointer,
            store=None,
        )


    # ---------------------------------------------------------------------
    # Lifecycle hooks
    # ---------------------------------------------------------------------
    def load_skills(self) -> list[str]:
        """Skills the agent should expose at startup.

        Returns the ``/skills/`` virtual root which the CompositeBackend
        resolves to ``<user_root>/agents/<agent_slug>/skills/``. The agent
        therefore sees ONLY skills the user has explicitly enabled for
        this (user, agent) pair. The central registry is not mounted —
        users browse it via the ProfilePanel Skills tab, and the bridge's
        PUT endpoint copies registry directories into this mount when the
        user enables a skill.
        """
        self._resolve_user_filesystem_root()  # ensure tree exists
        return ["/skills/"]


    def load_memory(self) -> Any:
        """
        Override to open and return a long-term memory store for this agent.

        Use ``self.memory_dir`` as the root path.  The returned value is stored
        on ``self.memory`` before ``register_agent()`` is called.
        """
        return None


    def load_agent_md(self) -> list[str]:
        """The shared cross-agent user memory file.

        Resolved through the CompositeBackend ``/memories/`` route, which
        maps to ``<user_root>/AGENT.md``. The provisioner seeds this file
        from the standard template on first run; the agent edits it via
        ``edit_file`` over time to accumulate durable user facts.
        """
        self._resolve_user_filesystem_root()  # ensure file exists
        return ["/memories/AGENT.md"]


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
            logger.info("deep_agent_build_started", "Deep agent build started", agent_slug=self.name)
            if self.checkpointer is None:
                self.checkpointer = MemorySaver()
            self.skills_paths   = self.load_skills()
            self.memory         = self.load_memory()
            self.agent_md_paths = self.load_agent_md()
            self.sub_agents     = self.register_subagents()
            self.agent          = self.register_agent()
            logger.info(
                "deep_agent_build_completed",
                "Deep agent build completed",
                agent_slug=self.name,
                skills_count=len(self.skills_paths),
                agent_md_count=len(self.agent_md_paths),
                has_memory=self.memory is not None,
                has_subagents=self.sub_agents is not None,
            )


    # ---------------------------------------------------------------------
    # Public lifecycle helpers (used by ``astream`` and HITL resume)
    # ---------------------------------------------------------------------
    async def ensure_built(self) -> None:
        """Rehydrate the per-thread checkpointer from cache and build the agent.

        Idempotent: safe to call multiple times. The HITL ``/resume`` endpoint
        invokes this directly so it can read ``self.compiled.get_state(...)``
        before issuing the resume command; ``astream`` also calls it to share
        the same cache-then-build path.
        """
        thread_id = self.run_config.get("configurable", {}).get("thread_id") or ""
        if self.checkpointer is None and thread_id:
            # Bind the process-wide durable saver (shared across all threads).
            # Thread-less runs fall back to an ephemeral MemorySaver in build().
            self.checkpointer = get_checkpointer()
        self.build()


    @property
    def compiled(self) -> Any:
        """The compiled runnable produced by ``build()``. ``None`` until built."""
        return self.agent



    # ---------------------------------------------------------------------
    # Streaming interface
    # ---------------------------------------------------------------------
    async def astream(self, payload: Mapping[str, Any], *, command: Optional[Command] = None) -> Any:
        """
        Build on demand and stream agent outputs in AG-UI format.

        Args:
            payload: Input mapping for the agent. Expected key: ``messages``.
            command: Optional ``langgraph.types.Command``. When provided it is
                fed to the underlying agent in place of ``payload`` so a
                previously paused HITL run can be resumed from its saved
                checkpoint.
        Yields:
            Streamed SSE bytes in AG-UI format.
        """
        try:
            await self.ensure_built()
            logger.info(
                "deep_agent_execution_started",
                "Deep agent execution started",
                agent_slug=self.name,
                stream_mode=self.stream_mode,
                resumed=command is not None,
            )

            agent_input: Any = command if command is not None else payload
            async for chunk in self.agent.astream(
                agent_input,
                config=self.run_config,
                stream_mode=self.stream_mode,
                subgraphs=True,
            ):
                if isinstance(chunk, (str, bytes)):
                    yield chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                else:
                    for agui_event in self.agui_normalizer.handle_chunk(chunk):
                        yield agui_event
            logger.info("deep_agent_execution_completed", "Deep agent execution completed", agent_slug=self.name)
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            logger.info("deep_agent_execution_cancelled", "Deep agent execution cancelled", agent_slug=self.name)
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
            logger.info(
                "deep_agent_reserved_tools_excluded",
                "Deep agent excluded reserved internal tools from MCP attachment",
                agent_slug=self.name,
                excluded_tools=sorted(set(excluded_names)),
            )

        super()._apply_live_tools(filtered_tools)
