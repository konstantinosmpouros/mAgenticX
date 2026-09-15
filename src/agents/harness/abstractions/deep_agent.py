from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, List, Mapping, Optional, Literal, Sequence
from abc import abstractmethod, ABC

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend
from langgraph.checkpoint.memory import MemorySaver

from harness.agui import AGUIEmitter, AGUIStreamNormalizer
from harness.abstractions.base_agent import AgentType, BaseAgent
from harness.personalization import build_personalization_prompt
from harness.prompt_engineering import PromptContext, compose_system_prompt, describe_sections
from harness.tools.gates import resolve_interrupt_on, strip_reserved_names, trust_level
from harness.tools.registry import NativeToolContext, build_auto_attach_tools
from harness.middlewares import (
    ConfigurableSummarizationMiddleware,
    ToolErrorMiddleware,
    build_summarization_middleware,
    exclude_stock_summarization,
)
from harness.filesystem import (
    build_workspace_backend,
    ensure_user_agent_filesystem,
    workspace_write_deny,
)
from core.logging import get_logger
from core.settings import settings

logger = get_logger(__name__)

STREAMING_MODES = Literal["updates", "messages"]
SubAgentsT = Sequence[Any] | Mapping[str, Any] | None

class DeepAgent(BaseAgent, ABC):
    """
    Blueprint for deep/autonomous agents.

    Extends ``BaseAgent`` with a structured build lifecycle and convention-based
    asset discovery.  Subclasses only need to implement ``register_agent()``;
    every other hook has a sensible default so the constructor never needs to be
    touched.

    Build lifecycle (invoked automatically by ``astream()`` on first run):

        load_skills()        → self.skills_paths   (auto-discovered: ["./skills/"])
        load_agent_md()      → self.agent_md_paths  (per-(user,agent): ["/memories/AGENTS.md"])
        register_subagents() → self.sub_agents       (nested agents, if any)
        register_agent()  ★  → self.agent            (the final runnable)

    Assets are **virtual mount routes**, not paths on the subclass's package —
    ``harness.filesystem.workspace`` maps them to this (user, agent,
    conversation)'s tree:

        /memories/AGENTS.md      — per-(user, agent) memory index (→ self.agent_md_paths)
        /skills/                 — skills the user enabled       (→ self.skills_paths)
        /default_skills/         — skills the agent ships with   (when declared)

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

    _log_domain: str = "deep_agent"

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

        # Per-request cache of the resolved per-user filesystem root (set on
        # first use; avoids re-resolving across the build hooks).
        self._user_filesystem_root: Optional[Path] = None

        # Agent components — populated during ensure_built()
        # Skill *sources* for create_deep_agent(skills=[...]): a virtual route, or a
        # (route, label) tuple. Labels render as "**<label> Skills**" in the prompt.
        self.skills_paths: list[str | tuple[str, str]] = []
        self.agent_md_paths: list[str] = []     # /memories/AGENTS.md — for create_deep_agent(memory=[...])
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



    @property
    def compiled(self) -> Any:
        """The runnable assembled by ``register_agent()``. ``None`` until built."""
        return self.agent


    def _stream_kwargs(self) -> dict[str, Any]:
        """``subgraphs=True`` so a sub-agent's chunks arrive namespaced — the
        normalizer keys its AG-UI bindings on that namespace."""
        return {"subgraphs": True}



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
        ``harness.filesystem.workspace`` — co-located because the permissions
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
        # one place (harness/tools/registry.py). Gating is unchanged: the builder
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
                run_id=ctx.get("run_id"),
                thread_id=ctx.get("thread_id"),
                trust_level=trust_level(self.tools),
            )
        )


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


    def prompt_context(self, *, has_subagents: bool = False) -> PromptContext:
        """What this run has, for the prompt composer to describe.

        Every field is read from the same flag that builds the thing it names,
        so a section can never advertise a mount or tool the run lacks. Override
        to suppress a section for one agent — returning a context with
        ``use_memory=False`` drops the memory block without touching the mount.
        """
        ctx = self.context or {}
        return PromptContext(
            use_memory=self.use_memory,
            has_subagents=has_subagents,
            has_conversation=bool(ctx.get("conversation_id")),
            has_reference=self.reference_dir is not None,
            has_default_skills=self.default_skills_dir is not None,
            search_past_convs=bool(ctx.get("search_past_convs")),
            sandbox_enabled=settings.filesystem.sandbox_execution_enabled,
            now=datetime.now(timezone.utc),
            personalization=build_personalization_prompt(self.personalization),
        )


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

        # The agent's own instructions lead; the platform sections are appended
        # by the composer, which owns their order. Every section is empty when
        # its feature is off, so an agent with nothing enabled composes to
        # exactly the instructions it was given.
        prompt_context = self.prompt_context(has_subagents=bool(subagents))
        system_prompt = compose_system_prompt(system_prompt, prompt_context)
        logger.info(
            "deep_agent_prompt_composed",
            "Composed the system prompt from the agent's instructions",
            agent_slug=self.name,
            sections=describe_sections(prompt_context),
            personality=self.personalization.personality,
            has_custom_instructions=self.personalization.has_custom_instructions,
        )

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

        # Selection already happened in _filter_live_tools; builtins are appended
        # here and are structurally out of reach of any user disable.
        resolved_tools = self.tools + self._builtin_tools()

        # `is not None` and not truthiness: a spec that deliberately declares no
        # gates passes `{}` and must stay empty rather than falling back to the
        # class attribute. The layer order itself lives in harness.tools.gates.
        resolved_interrupt_on = resolve_interrupt_on(
            resolved_tools,
            own_gates=interrupt_on if interrupt_on is not None else self.hitl_gates,
            approvals=self.tool_config.approvals,
            agent_slug=self.name,
        )

        return create_deep_agent(
            model=model,
            name=self.name,
            tools=resolved_tools,
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
            self.checkpointer    — ephemeral InMemorySaver for HITL
            self.sub_agents      — nested agents (or None)
            self.tools           — filtered live MCP tools

        Call ``self.build_deep_agent(...)`` rather than ``create_deep_agent``
        directly — it injects the workspace backend, its permission ladder, the
        builtins, the composed system prompt and the approval gates, none of
        which a subclass should assemble by hand.
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
        if self.checkpointer is None:
            # Durable saver when this run has a thread; None otherwise, and the
            # ephemeral MemorySaver below takes over.
            self.checkpointer = self._durable_checkpointer()
        if self.agent is not None:
            return
        logger.info("deep_agent_build_started", "Deep agent build started", agent_slug=self.name)
        if self.checkpointer is None:
            self.checkpointer = MemorySaver()
        self.skills_paths   = self.load_skills()
        self.agent_md_paths = self.load_agent_md()
        self.sub_agents     = self.register_subagents()
        self.agent          = self.register_agent()
        logger.info(
            "deep_agent_build_completed",
            "Deep agent build completed",
            agent_slug=self.name,
            skills_count=len(self.skills_paths),
            agent_md_count=len(self.agent_md_paths),
            has_subagents=self.sub_agents is not None,
        )



    # ---------------------------------------------------------------------
    # Tool management
    # ---------------------------------------------------------------------
    def _apply_live_tools(self, tools: Sequence[Any]) -> None:
        """Attach live MCP tools, minus any whose name a prebuilt tool owns."""
        super()._apply_live_tools(strip_reserved_names(tools, agent_slug=self.name))
