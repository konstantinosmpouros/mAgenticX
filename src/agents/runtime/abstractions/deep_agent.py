import asyncio
import inspect
from pathlib import Path
from typing import Any, Callable, List, Mapping, Optional, Literal, Sequence, Set
from abc import abstractmethod, ABC

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from runtime.agui import AGUIEmitter, AGUIStreamNormalizer
from runtime.abstractions.base_agent import AgentType, BaseAgent
from runtime.checkpointer import get_checkpointer
from runtime.personalization import build_personalization_prompt
from runtime.tools.registry import (
    NATIVE_TOOLS,
    NativeToolContext,
    build_auto_attach_tools,
    native_hitl_defaults,
)
from runtime.middlewares import (
    ConfigurableSummarizationMiddleware,
    ToolErrorMiddleware,
    build_summarization_middleware,
    exclude_stock_summarization,
)
from runtime.filesystem import (
    build_workspace_backend,
    ensure_user_agent_filesystem,
    workspace_write_deny,
)
from runtime.filesystem.tool_prefs import read_disabled_tools
from utils import get_tool_cache_key
from core.logging import get_logger

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

    # built-in memory
    "remember",

    # built-in deliverables
    "present_artifact",

    # built-in skill authoring
    "create_skill",
}


# Memory-usage instructions appended to a deep agent's system prompt **only when
# memory is enabled** (see DeepAgent._memory_system_prompt). Kept out of the
# agents' static prompts so a use_memory=False run never advertises a /memories/
# mount it doesn't have. Describes the per-(user, agent) AGENTS.md index + entries
# progressive-disclosure pattern and the `remember` write tool.
_MEMORY_SYSTEM_PROMPT = """\
## Your Long-Term Memory

You have a persistent memory about THIS user, private to you and carried across
every conversation you have with them:

- `/memories/AGENTS.md` — your memory **index**, loaded into your context
  automatically at the start of each conversation. Each row is
  `- **<name>** — <summary>`, one per saved memory.
- When a row looks relevant, read its full detail with
  `read_file /memories/entries/<name>.yml`.
- To save something durable (a preference, an ongoing project, a key person, a
  decision, an important date), call the `remember` tool with a short `name`, a
  one-line `summary`, and the full `content`. Re-using a `name` updates that
  memory in place.

Save only durable, reusable facts — never transient chatter. This memory is the
only thing that outlives the current conversation (your `/conversation/`
workspace does not carry over)."""


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
        load_agent_md()      → self.agent_md_paths  (per-(user,agent): ["/memories/AGENTS.md"])
        register_subagents() → self.sub_agents       (nested agents, if any)
        register_agent()  ★  → self.agent            (the final runnable)

    Convention-based asset discovery (all paths relative to the concrete
    subclass file, resolved via inspect at runtime):

        /memories/AGENTS.md      — per-(user, agent) memory index (→ self.agent_md_paths)
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

    # Every concrete DeepAgent IS a deep agent; the bridge persists this in
    # agents.type and the UI shows the skill panel only for it.
    type: AgentType = "deep agent"

    # Concrete subclasses set this to their system prompt (passed to
    # create_deep_agent(system_prompt=...)). Skills come from the user's pool.
    instructions: str = ""

    # Middleware exposed on the instance so a subclass composes its stack via self
    # (no imports). build_summarization_middleware is the configured factory.
    tool_error_middleware = ToolErrorMiddleware
    summarization_middleware = ConfigurableSummarizationMiddleware
    build_summarization_middleware = staticmethod(build_summarization_middleware)


    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(config=config)

        # Directory of the concrete subclass file — source assets live here
        self._impl_dir: Path = Path(inspect.getfile(type(self))).parent

        # Per-request cache of the resolved per-user filesystem root (set on
        # first use; avoids re-resolving across the build hooks).
        self._user_filesystem_root: Optional[Path] = None

        # Agent components — populated during ensure_built()
        # Skill *sources* for create_deep_agent(skills=[...]): a virtual route, or a
        # (route, label) tuple. Labels render as "**<label> Skills**" in the prompt.
        self.skills_paths: list[str | tuple[str, str]] = []
        self.agent_md_paths: list[str] = []     # /memories/AGENTS.md — for create_deep_agent(memory=[...])
        self.memory: Any = None
        # Bound lazily in ensure_built() so a HITL resume picks up the paused
        # checkpoint instead of a fresh saver.
        self.checkpointer: MemorySaver | None = None
        self.sub_agents: SubAgentsT = None
        self.agent: Any = None

        # AGUI: the normalizer keys message_id / sub-agent namespaces on the
        # per-run id (run_id), falling back to the LangGraph thread_id.
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


    @property
    def compiled(self) -> Any:
        """The compiled runnable produced by ``build()``. ``None`` until built."""
        return self.agent



    # ---------------------------------------------------------------------
    # Per-user filesystem resolution
    # ---------------------------------------------------------------------
    def _resolve_user_filesystem_root(self) -> Path:
        """Provision (idempotently) and return ``<filesystem_root>/<user_id>/``.

        Reads ``user_id`` and ``conversation_id`` from ``self.context`` — the
        bridge stamps both on every request, and
        ``BaseAgent._validate_context_config`` rejects payloads that omit
        either. The first call for a (user, agent) pair seeds the ``AGENTS.md``
        memory index from the standard template; the skills directory is created empty
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


    def _build_composite_backend(self) -> Callable[[Any], CompositeBackend]:
        """Delegate to the filesystem workspace builder for this run's identity.

        The mount layout (virtual routes → per-(user, agent, conversation)
        roots) and its write-deny ladder live together in
        ``runtime.filesystem.workspace`` — co-located because the permissions
        target the mount routes and must stay in sync. The agent only decides
        *policy* here: the resolved ``self.use_memory`` toggle (drops the
        ``/memories/`` mount when off). Permissions are applied in
        ``build_deep_agent`` via ``WORKSPACE_WRITE_DENY``.
        """
        ctx = self.context
        return build_workspace_backend(
            user_id=ctx["user_id"],
            agent_slug=self.name,
            conversation_id=ctx["conversation_id"],
            use_memory=self.use_memory,
            reference_dir=self.reference_dir,
            default_skills_dir=self.default_skills_dir,
        )


    @property
    def reference_dir(self) -> Optional[Path]:
        """Folder to mount read-only at ``/reference/``, or ``None`` for no mount.

        A hook for definition-bundled material the agent should be able to read
        on demand. ``None`` by default: an agent written in code has no such
        folder, and its package directory holds source, which must never be
        readable from a run. Declarative agents override this with their own
        definition directory.
        """
        return None


    def default_middleware(self, model: Any, backend: Any) -> list[Any]:
        """The middleware stack a deep agent gets unless it overrides this.

        Override to add/drop/reconfigure middleware. ``ToolErrorMiddleware`` is
        force-guaranteed by ``build_deep_agent`` regardless, so it's safe to omit
        here. The summarizer replaces deepagents' stock one with env-tuned
        thresholds and offloads to ``backend`` (the shared per-conversation disk).
        """
        return [
            self.tool_error_middleware(),
            self.build_summarization_middleware(model, backend),
        ]


    def _builtin_tools(self) -> List[Any]:
        """Built-in tools every deep agent gets regardless of the client's MCP
        tool selection. Bound to this run's user/agent/conversation (read from
        ``self.context``), which is safe because each request builds its own
        agent instance + compiled graph — nothing is shared across users. All
        are skipped when there is no user context (e.g. registry warmup).

        Two independent preference gates:

        * ``remember`` (write to this (user, agent)'s persistent memory) is
          attached whenever ``self.use_memory`` is on — the same flag that
          mounts the ``/memories/`` tree it writes to. No point letting an agent
          save into a memory that isn't mounted.
        * ``search_past_conversations`` (cross-conversation semantic recall via
          the bridge's pgvector index) is **opt-in** via ``search_past_convs``.
        * ``present_artifact`` (designate a finished output/ file as a
          user-facing deliverable) is attached whenever there's a
          ``conversation_id`` — it has no preference gate but needs a
          conversation whose output/ mount it can point into.
        """
        ctx = self.context or {}
        user_id = ctx.get("user_id")
        if not user_id:
            return []
        # Delegate to the native-tool registry so the always-on builtins live in
        # one place (runtime/tools/registry.py). Gating is unchanged: the builder
        # for each auto-attach tool returns None when its gate is off
        # (remember→use_memory, search_past_conversations→search_past_convs,
        # present_artifact→conversation_id present).
        return build_auto_attach_tools(
            NativeToolContext(
                user_id=user_id,
                agent_slug=self.name,
                conversation_id=ctx.get("conversation_id"),
                use_memory=self.use_memory,
                search_past_convs=bool(ctx.get("search_past_convs")),
            )
        )


    def _apply_tool_disables(self, tools: List[Any]) -> List[Any]:
        """Drop MCP tools the user disabled for this (user, agent) from the built
        set.

        The user may disable a subset of the agent's MCP tools per agent (the
        Agents tab → ``runtime/filesystem/tool_prefs``). Matching is by canonical
        cache key (``get_tool_cache_key``). **Native builtins are never dropped**:
        they aren't managed by this tab (``remember`` / ``search_past_conversations``
        follow the Personalization prefs; ``present_artifact`` is always on), so
        native keys are subtracted from the disabled set here — this also neutralizes
        any legacy pre-model disable of a native. No-op when there's no user
        context or no disables.
        """
        user_id = (self.context or {}).get("user_id")
        if not user_id:
            return tools
        disabled = read_disabled_tools(user_id, self.name) - set(NATIVE_TOOLS)
        if not disabled:
            return tools
        kept = [tool for tool in tools if get_tool_cache_key(tool) not in disabled]
        removed = len(tools) - len(kept)
        if removed:
            logger.info(
                "agent_tools_disabled_filtered",
                "Removed user-disabled tools for (user, agent)",
                agent_slug=self.name,
                removed_count=removed,
            )
        return kept


    @staticmethod
    def _ensure_tool_error_middleware(stack: Optional[Sequence[Any]]) -> list[Any]:
        """Return ``stack`` with ``ToolErrorMiddleware`` guaranteed (prepended if
        missing, never duplicated). Applied by ``build_deep_agent`` to the agent
        and every sub-agent so a tool error degrades to a ToolMessage instead of
        aborting — whatever middleware a concrete agent sets.
        """
        items = list(stack or [])
        if not any(isinstance(m, ToolErrorMiddleware) for m in items):
            items.insert(0, ToolErrorMiddleware())
        return items


    def _memory_system_prompt(self) -> str:
        """The memory-usage block appended to the system prompt when memory is on.

        Empty when ``self.use_memory`` is off, so a run with memory disabled is
        never told it has a ``/memories/`` mount it doesn't actually have (the
        cause of the agent claiming access to ``/memories/AGENTS.md`` with the
        toggle off). Override to customise the wording.
        """
        return _MEMORY_SYSTEM_PROMPT if self.use_memory else ""


    def _personalization_system_prompt(self) -> str:
        """The user-personalization block (personality preset + custom
        instructions) appended to the system prompt.

        Empty when the run carries no effective personalization, so a default
        run's prompt is identical to the pre-feature one. The block itself is
        composed and hardened in ``runtime.personalization`` — override this to
        customise placement or suppress personalization for a specific agent.
        """
        return build_personalization_prompt(self.personalization)


    def build_deep_agent(
        self,
        *,
        model: Any,
        system_prompt: Any = None,
        subagents: SubAgentsT = None,
        interrupt_on: dict[str, Any] | None = None,
        middleware: Optional[List[Any]] = None,
    ) -> Any:
        """Assemble the runnable with the fixed, plug-and-play filesystem wiring
        injected from the base — memory, skills, the per-(user, agent,
        conversation) CompositeBackend, and its permission ladder. These are
        identical for every deep agent; only the on-disk roots vary, computed
        per (user, agent, conversation) at tool-call time. Concrete agents call
        this from ``register_agent()`` and supply only what differs: model,
        system prompt, sub-agents, and HITL gating. Agent-specific tools come
        from ``self.tools`` (populate them via ``attach_tools()``).

        Middleware is per-implementation: ``middleware`` defaults to
        ``default_middleware(model, backend)``; pass an explicit list (or
        override ``default_middleware``) to customise the stack. deepagents
        always auto-injects its own stock ``SummarizationMiddleware``, so we
        drop it here — our tuned summarizer in the stack becomes the only one
        (and if the stack carries none, the agent simply runs without
        auto-compaction).
        """
        backend = self._build_composite_backend()
        stack = middleware if middleware is not None else self.default_middleware(model, backend)
        stack = self._ensure_tool_error_middleware(stack)  # guarantee on the main agent
        exclude_stock_summarization(model if isinstance(model, str) else "")

        # Append the user-personalization block (personality preset + custom
        # instructions, threaded from preferences by the bridge) right after the
        # agent's static instructions, then the memory-usage block. Both are
        # empty when inactive, so a default run's prompt is unchanged.
        personalization_prompt = self._personalization_system_prompt()
        if personalization_prompt:
            system_prompt = (
                f"{system_prompt}\n\n{personalization_prompt}" if system_prompt else personalization_prompt
            )
            logger.info(
                "deep_agent_personalization_applied",
                "Applied user personalization to the system prompt",
                agent_slug=self.name,
                personality=self.personalization.personality,
                has_custom_instructions=self.personalization.has_custom_instructions,
            )

        # Append the memory-usage instructions only when memory is enabled, so the
        # agent is told about /memories/ exactly when the mount + remember tool
        # are actually present (keep memory wording out of the static prompt).
        memory_prompt = self._memory_system_prompt()
        if memory_prompt:
            system_prompt = f"{system_prompt}\n\n{memory_prompt}" if system_prompt else memory_prompt

        # Sub-agents get the same guarantee separately (parent middleware doesn't
        # reach them); pre-compiled "runnable" specs pass through untouched.
        augmented_subagents: SubAgentsT = subagents
        if isinstance(subagents, (list, tuple)):
            augmented_subagents = [
                {**spec, "middleware": self._ensure_tool_error_middleware(spec.get("middleware"))}
                if isinstance(spec, dict) and "runnable" not in spec
                else spec
                for spec in subagents
            ]

        # Native tools that declare themselves dangerous are gated by default;
        # the agent's own spec layers on top and can still speak for itself.
        # (A user-authored spec additionally cannot lower the _HITL_FLOOR — see
        # runtime/abstractions/user_agents.py.)
        resolved_interrupt_on = {**native_hitl_defaults(), **(interrupt_on or {})}

        return create_deep_agent(
            model=model,
            name=self.name,
            tools=self._apply_tool_disables(self.tools + self._builtin_tools()),
            system_prompt=system_prompt,
            subagents=augmented_subagents,
            interrupt_on=resolved_interrupt_on,
            middleware=stack,
            # Fixed filesystem — same mounts + permissions for every deep agent.
            memory=self.agent_md_paths,
            skills=self.skills_paths,
            backend=backend,
            # Derived from the same flag as the mount, so a rule can never point
            # at a route this run didn't mount.
            permissions=workspace_write_deny(
                include_reference=self.reference_dir is not None,
                include_default_skills=self.default_skills_dir is not None,
            ),
            context_schema=self.context,
            checkpointer=self.checkpointer,
            store=None,
        )



    # ---------------------------------------------------------------------
    # Lifecycle hooks
    # ---------------------------------------------------------------------
    def load_skills(self) -> list[str | tuple[str, str]]:
        """Skill sources the agent should expose at startup, in precedence order.

        ``/skills/`` (tier ②) resolves to ``<user_root>/agents/<slug>/skills/`` —
        ONLY the skills the user explicitly enabled for this (user, agent) pair.
        The central registry is never mounted; users browse it in the Skills tab
        and the bridge's PUT endpoint copies directories into this mount.

        When the agent ships with skills of its own (``default_skills_dir``),
        ``/default_skills/`` (tier ①) is appended. **Order matters:** deepagents
        loads sources left to right and later sources win on a name clash, so the
        defaults go last — a user cannot neutralise a skill the agent ships with
        by putting a same-named one in their pool. The mount is also write-denied,
        so "add to, never remove" holds structurally rather than by UI convention.

        Both sources carry an explicit label because deepagents derives one from
        the path otherwise, and a bare ``/skills/`` derives ``Skills`` — rendering
        as the duplicative "**Skills Skills**" its own docs warn about.
        """
        self._resolve_user_filesystem_root()  # ensure tree exists
        sources: list[str | tuple[str, str]] = [("/skills/", "Your")]
        if self.default_skills_dir is not None:
            sources.append(("/default_skills/", "Built-in"))
        return sources


    @property
    def default_skills_dir(self) -> Optional[Path]:
        """Directory of skills this agent ships with, or ``None`` for none.

        A policy hook, like :attr:`reference_dir`. ``None`` by default: an agent
        defined in code declares its skills in code. Declarative agents resolve
        it from their spec — platform agents straight out of their global folder,
        user-authored ones from the copy made in their workspace when the agent
        was saved.
        """
        return None


    def load_memory(self) -> Any:
        """
        Override to open and return a long-term memory store for this agent.

        Use ``self.memory_dir`` as the root path.  The returned value is stored
        on ``self.memory`` before ``register_agent()`` is called.
        """
        return None


    def load_agent_md(self) -> list[str]:
        """This (user, agent)'s memory index file.

        Resolved through the CompositeBackend ``/memories/`` route, which maps
        to ``<user_root>/agents/<self.name>/memory/AGENTS.md``. The provisioner
        seeds it from the standard template on first run; the ``remember`` tool
        maintains it (one summary line per memory, pointing at ``entries/``)
        and deepagents' MemoryMiddleware injects it as always-on context.

        Returns ``[]`` when memory is disabled for this run (``self.use_memory``
        False, threaded from the user's preference) so ``create_deep_agent``
        receives no always-on memory file — paired with omitting the
        ``/memories/`` mount in ``_build_composite_backend``.
        """
        if not self.use_memory:
            return []
        self._resolve_user_filesystem_root()  # ensure file exists
        return ["/memories/AGENTS.md"]


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
    # Build (used by ``astream`` and the HITL resume endpoint)
    # ---------------------------------------------------------------------
    async def ensure_built(self) -> None:
        """Rehydrate the per-thread checkpointer, then run the lifecycle hooks in
        order and assemble the agent.

        Idempotent: safe to call multiple times — once ``self.agent`` exists it
        returns immediately. The HITL ``/resume`` endpoint invokes this directly
        so it can read ``self.compiled.get_state(...)`` before issuing the resume
        command; ``astream`` calls it too, sharing the same build path.
        """
        thread_id = self.run_config.get("configurable", {}).get("thread_id") or ""
        if self.checkpointer is None and thread_id:
            # Bind the process-wide durable saver (shared across all threads).
            # Thread-less runs fall back to the ephemeral MemorySaver below.
            self.checkpointer = get_checkpointer()
        if self.agent is not None:
            return
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
