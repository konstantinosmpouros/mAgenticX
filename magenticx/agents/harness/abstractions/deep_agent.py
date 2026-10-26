from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, List, Mapping, Optional, Literal, Sequence
from abc import abstractmethod, ABC

from deepagents import ProviderProfile, create_deep_agent, register_provider_profile
from deepagents._models import resolve_model
from deepagents.backends import CompositeBackend
# Private, but the very merge create_deep_agent applies to its own sub-agents'
# gates; a sub-agent built below depth 1 must get the same.
from deepagents.graph import _merge_fs_interrupt_on
from deepagents.middleware._fs_interrupt import _build_interrupt_on_from_permissions
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT, SubAgentMiddleware
from deepagents.middleware.summarization import create_summarization_middleware
from langchain.agents.middleware import TodoListMiddleware
from langchain_anthropic.middleware import AnthropicPromptCachingMiddleware
from langgraph.checkpoint.memory import MemorySaver

from harness.agui import AGUIEmitter, AGUIStreamNormalizer
from harness.abstractions.base_agent import AgentType, BaseAgent
from harness.abstractions.subagent_tree import SUBAGENTS_KEY, validate_subagent_tree
from harness.commands import command_permissions
from harness.personalization import build_personalization_prompt
from harness.prompt_engineering import PromptContext, compose_system_prompt, describe_sections
from harness.prompt_engineering.prompts.capabilities_prompt import delegating_subagent_prompt
from harness.tools.ask_user import ASK_USER_TOOL_NAME
from harness.tools.gates import resolve_interrupt_on, strip_reserved_names, trust_level
from harness.tools.registry import NativeToolContext, build_auto_attach_tools
from harness.middlewares import (
    ConfigurableSummarizationMiddleware,
    FirstTokenCallback,
    RetryOnRateLimitMiddleware,
    ToolErrorMiddleware,
    ToolMetricsMiddleware,
    UsageMetricsMiddleware,
    build_summarization_middleware,
    exclude_stock_summarization,
    find_summarizer,
)
from harness.conversation_files import ConversationFiles, ConversationFileStore
from harness.filesystem import build_workspace_backend, workspace_write_deny
from harness.memory import get_memory_pool
from core.logging import get_logger
from core.settings import settings

logger = get_logger(__name__)

STREAMING_MODES = Literal["updates", "messages", "tasks"]
SubAgentsT = Sequence[Any] | Mapping[str, Any] | None


def _without_ask_user(tools: Sequence[Any] | None) -> list[Any]:
    """``tools`` minus ``ask_user``: only the main agent may pause the run on a
    question, at any depth (the tool also refuses a sub-agent's call)."""
    return [t for t in (tools or []) if getattr(t, "name", None) != ASK_USER_TOOL_NAME]


def _unique_by_name(tools: Sequence[Any]) -> list[Any]:
    """``tools`` with each name once, the first kept. A YAML spec may list a
    native tool that is also always-on (``{native: render_chart}``), and the
    model API rejects two tools with one name."""
    seen: set[str] = set()
    unique: list[Any] = []
    for tool in tools:
        name = getattr(tool, "name", None)
        if name is not None and name in seen:
            continue
        if name is not None:
            seen.add(name)
        unique.append(tool)
    return unique


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

    # `provider:model` specs whose context window this process has declared
    # (see register_model_windows); registration merges, so once is enough.
    _windows_registered: set[str] = set()

    # Default streaming mode. "tasks" emits no events of its own: it tells the
    # normalizer which `task` call each sub-agent namespace runs (exact for
    # parallel and nested sub-agents, and on a /resume stream).
    stream_mode: List[STREAMING_MODES] = ["messages", "updates", "tasks"]

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
    usage_metrics_middleware = UsageMetricsMiddleware
    rate_limit_middleware = RetryOnRateLimitMiddleware
    tool_metrics_middleware = ToolMetricsMiddleware

    # The main agent's own summarizer once built (None when its stack carries
    # none) — what a manual compaction of this agent's thread runs (plan 34).
    summarizer: Optional[ConfigurableSummarizationMiddleware] = None


    def __init__(self, *, config: Optional[Mapping[str, Any]] = None) -> None:
        super().__init__(config=config)

        # This run's conversation files, built on first use (see
        # `conversation_files`) and shared by the mounts and the file tools.
        self._conversation_files: Optional[ConversationFiles] = None

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


    def _stream_config(self) -> Mapping[str, Any]:
        """``run_config`` plus the first-token callback: the only thing that sees
        a model call's streamed chunks, so ``UsageMetricsMiddleware`` can report
        time to first token. LangChain carries it into every sub-agent."""
        return self._config_with_callback(FirstTokenCallback())



    # ---------------------------------------------------------------------
    # The conversation's files
    # ---------------------------------------------------------------------
    @property
    def conversation_files(self) -> ConversationFiles:
        """This run's view of its conversation's files (plan 43).

        One instance per run, so the mounts, ``view_image`` and
        ``present_artifact`` share it — the uploads are listed once per run
        however many of them look. ``user_id`` and ``conversation_id`` come
        from ``self.context``, which ``BaseAgent._validate_context_config``
        guarantees.
        """
        if self._conversation_files is None:
            ctx = self.context
            self._conversation_files = ConversationFiles(
                user_id=ctx["user_id"],
                conversation_id=ctx["conversation_id"],
                agent_slug=self.name,
                store=ConversationFileStore(get_memory_pool()),
                run_id=ctx.get("run_id"),
            )
        return self._conversation_files


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
        return build_workspace_backend(
            user_id=self.context["user_id"],
            agent_slug=self.name,
            files=self.conversation_files,
            use_memory=self.use_memory,
            reference_dir=self.reference_dir,
            reference_namespace=self.reference_namespace,
            default_skills_dir=self.default_skills_dir,
            declared_skills=self.declared_skills,
        )


    @property
    def reference_dir(self) -> Optional[Path]:
        """Folder to mount read-only at ``/reference/``, or ``None`` for no mount.

        A hook for definition-bundled material the agent should be able to read
        on demand. ``None`` by default: an agent written in code has no such
        folder, and its package directory holds source, which must never be
        readable from a run. **Platform** declarative agents override this with
        their own image directory.
        """
        return None


    @property
    def reference_namespace(self) -> tuple[str, ...] | None:
        """Store namespace to mount read-only at ``/reference/``, or ``None``.

        The database-backed twin of :attr:`reference_dir`, for a **user-authored**
        agent: its definition is rows in ``agent_runtime``, not a folder, so the
        mount is a ``StoreBackend`` over ``(user_id, agent_slug)``.

        Exactly one of the two is ever set. Kept as separate hooks rather than
        one polymorphic "source" because they mount different backend classes,
        and collapsing them would hide which agents can still be tampered with
        on disk and which cannot.
        """
        return None


    @property
    def _has_reference(self) -> bool:
        """Whether this run mounts ``/reference/`` at all, from either source.

        The mount, the write-deny rule and the prompt section all derive from
        this one answer — testing only the directory would leave the prompt
        advertising a route a custom agent's run did not mount, and the deny
        rule pointing at nothing. Same shape as :attr:`_has_default_skills`, for
        the same reason.
        """
        return self.reference_dir is not None or self.reference_namespace is not None


    def default_middleware(self, model: Any, backend: Any) -> list[Any]:
        """The middleware stack a deep agent gets unless it overrides this.

        Override to add/drop/reconfigure middleware. ``ToolErrorMiddleware``,
        ``ToolMetricsMiddleware``, ``RetryOnRateLimitMiddleware`` and
        ``UsageMetricsMiddleware`` are force-guaranteed by ``build_deep_agent``
        regardless, so it's safe to omit them here. The summarizer replaces
        deepagents' stock one with env-tuned thresholds and offloads to
        ``backend`` (the shared per-conversation disk).
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
        * ``ask_user`` (clarifying questions, a HITL pause) additionally needs
          an interactive run — ``interactive`` in the context, false for a
          scheduled task's run, where nobody would ever answer.
        """
        ctx = self.context or {}
        user_id = ctx.get("user_id")
        if not user_id:
            return []
        # Delegate to the native-tool registry so the always-on builtins live in
        # one place (harness/tools/registry.py). Gating is unchanged: the builder
        # for each auto-attach tool returns None when its gate is off
        # (remember→use_memory, search_past_conversations→search_past_convs,
        # present_artifact / view_image→the conversation's files present).
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
                files=self.conversation_files if ctx.get("conversation_id") else None,
                interactive=self.interactive,
            )
        )


    @property
    def interactive(self) -> bool:
        """Whether someone is there to answer this run (``ask_user``'s gate).

        Absent means a chat turn: the bridge sends ``False`` only for a run with
        no one watching it (a scheduled task)."""
        return bool((self.context or {}).get("interactive", True))


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


    @staticmethod
    def _ensure_tool_metrics_middleware(stack: Sequence[Any] | None) -> list[Any]:
        """Return ``stack`` with ``ToolMetricsMiddleware`` guaranteed (never
        duplicated), so every tool call — main agent and every sub-agent — is
        reported as ``TOOL_USAGE``.

        Placed directly before ``ToolErrorMiddleware`` (first means outermost),
        so a tool that raised reaches it as the converted error ToolMessage and
        is counted as an error; first in the stack when there is none.
        """
        items = list(stack or [])
        if any(isinstance(m, ToolMetricsMiddleware) for m in items):
            return items
        index = next((i for i, m in enumerate(items) if isinstance(m, ToolErrorMiddleware)), 0)
        items.insert(index, ToolMetricsMiddleware())
        return items


    @classmethod
    def _ensure_platform_middleware(cls, stack: Sequence[Any] | None) -> list[Any]:
        """Every guarantee a deep agent's or sub-agent's stack gets, in order:
        tool errors degrade to results, tool calls are measured, rate limits
        are waited out, model calls are measured."""
        stack = cls._ensure_tool_error_middleware(stack)
        stack = cls._ensure_tool_metrics_middleware(stack)
        stack = cls._ensure_rate_limit_middleware(stack)
        return cls._ensure_usage_metrics_middleware(stack)


    @staticmethod
    def _ensure_rate_limit_middleware(stack: Optional[Sequence[Any]]) -> list[Any]:
        """Return ``stack`` with ``RetryOnRateLimitMiddleware`` guaranteed (first,
        never duplicated), so a provider rate limit pauses the main agent or a
        sub-agent instead of failing the run.

        First means outermost: ``UsageMetricsMiddleware`` (appended last) sits
        inside it and times only the attempt that answered, never the wait.
        """
        items = list(stack or [])
        if not any(isinstance(m, RetryOnRateLimitMiddleware) for m in items):
            items.insert(0, RetryOnRateLimitMiddleware())
        return items


    @staticmethod
    def _ensure_usage_metrics_middleware(stack: Optional[Sequence[Any]]) -> list[Any]:
        """Return ``stack`` with ``UsageMetricsMiddleware`` guaranteed (appended if
        missing, never duplicated), so every model call — main agent and every
        sub-agent — reports its model, latency and context occupancy.

        Its "compacts at" marker is set only when the stack really carries our
        summarizer (a sub-agent runs deepagents' stock one, a custom stack may
        run none), so the UI never shows a threshold that is not there.
        """
        items = list(stack or [])
        if any(isinstance(m, UsageMetricsMiddleware) for m in items):
            return items
        has_summarizer = any(isinstance(m, ConfigurableSummarizationMiddleware) for m in items)
        items.append(
            UsageMetricsMiddleware(
                compaction_fraction=settings.summarization.trigger_fraction if has_summarizer else None
            )
        )
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
            # The same gate as the tool's builder (a user, a conversation, an
            # interactive run): the rule never describes a tool the run lacks.
            has_ask_user=bool(ctx.get("user_id") and ctx.get("conversation_id")) and self.interactive,
            has_reference=self._has_reference,
            has_default_skills=self._has_default_skills,
            search_past_convs=bool(ctx.get("search_past_convs")),
            sandbox_enabled=settings.filesystem.sandbox_execution_enabled,
            now=datetime.now(timezone.utc),
            personalization=build_personalization_prompt(self.personalization),
        )


    @classmethod
    def register_model_windows(cls) -> None:
        """Declare the context window of models newer than the pinned LangChain.

        Compaction (the 95% trigger, the 5% floor) and the composer's context
        ring read a model's window from its LangChain profile. A model released
        after the pinned ``langchain-openai`` (``gpt-6-luna``) has no profile
        entry, so it would run with no window. Upgrading for one data row drags
        langchain-core and deepagents along, so the window comes from
        ``MODEL_CONTEXT_WINDOWS`` instead, handed to the model through
        deepagents' ``ProviderProfile`` when it resolves the string spec — which
        is why this runs before anything in the build resolves a model.
        """
        for spec, window in settings.model_profiles.context_windows.items():
            if spec in cls._windows_registered:
                continue
            register_provider_profile(spec, ProviderProfile(init_kwargs={"profile": {"max_input_tokens": window}}))
            cls._windows_registered.add(spec)
            logger.info("model_window_registered", "Declared a model's context window", model=spec, window=window)

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
        # Before anything resolves the model (the summarizer below, the
        # sub-agents inside create_deep_agent): the window rides the profile.
        self.register_model_windows()
        backend = self._build_composite_backend()
        stack = middleware if middleware is not None else self.default_middleware(model, backend)
        stack = self._ensure_platform_middleware(stack)  # guarantee on the main agent
        self.summarizer = find_summarizer(stack)
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

        # Selection already happened in _filter_live_tools; builtins are appended
        # here and are structurally out of reach of any user disable.
        resolved_tools = _unique_by_name([*self.tools, *self._builtin_tools()])

        # `is not None` and not truthiness: a spec that deliberately declares no
        # gates passes `{}` and must stay empty rather than falling back to the
        # class attribute. The layer order itself lives in harness.tools.gates.
        own_gates = interrupt_on if interrupt_on is not None else self.hitl_gates
        resolved_interrupt_on = resolve_interrupt_on(
            resolved_tools,
            own_gates=own_gates,
            approvals=self.tool_config.approvals,
            agent_slug=self.name,
        )

        # Derived from the same flag as the mount, so a rule can never point at a
        # route this run didn't mount. A slash command can only add rules here
        # (read-only), never lift one.
        permissions = workspace_write_deny(
            include_reference=self._has_reference,
            include_default_skills=self._has_default_skills,
        ) + command_permissions(self.command_spec)

        # Sub-agents get the platform guarantees separately (parent middleware
        # doesn't reach them), at every depth; pre-compiled "runnable" specs
        # pass through untouched.
        augmented_subagents = self._prepare_subagents(
            subagents,
            model=model,
            backend=backend,
            tools=resolved_tools,
            own_gates=own_gates,
            permissions=permissions,
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
            permissions=permissions,
            context_schema=self.context,
            checkpointer=self.checkpointer,
            store=None,
        )


    # ---------------------------------------------------------------------
    # Sub-agents, at every depth
    # ---------------------------------------------------------------------
    def _prepare_subagents(
        self,
        subagents: SubAgentsT,
        *,
        model: Any,
        backend: Any,
        tools: Sequence[Any],
        own_gates: Mapping[str, Any] | None,
        permissions: list[Any],
    ) -> SubAgentsT:
        """The main agent's sub-agent specs, ready for ``create_deep_agent``.

        deepagents builds the main agent's own sub-agents (depth 1) itself and
        gives each its base stack — planning, filesystem with ``permissions``,
        summarization, PatchToolCalls — and the run's approval gates. What it
        does not give them, and what this adds:

        * the platform middleware (``_ensure_platform_middleware``);
        * no ``ask_user``, ever: an inheriting sub-agent gets the main agent's
          tools *minus* ``ask_user`` (the tool also refuses at call time), and
          deepagents' general-purpose sub-agent is declared here so it is
          covered too;
        * a ``task`` tool of its own when the spec lists ``subagents`` — a
          ``SubAgentMiddleware`` whose specs are built fully by
          :meth:`_nested_subagent`, because deepagents processes nothing below
          depth 1;
        * a spec's own ``interrupt_on`` re-resolved through the gate layers,
          so a sub-agent can add a gate but never clear a locked one.
        """
        if not isinstance(subagents, (list, tuple)):
            return subagents
        validate_subagent_tree(subagents)
        inherited = _without_ask_user(tools)
        prepared: list[Any] = []
        for raw in subagents:
            if not isinstance(raw, Mapping) or "runnable" in raw:
                prepared.append(raw)
                continue
            spec = dict(raw)
            children = spec.pop(SUBAGENTS_KEY, None) or []
            spec["tools"] = _without_ask_user(spec["tools"]) if "tools" in spec else list(inherited)
            if "interrupt_on" in spec:
                spec["interrupt_on"] = self._subagent_gates(spec["tools"], spec["interrupt_on"], own_gates)
            stack = list(spec.get("middleware") or [])
            if children:
                stack.append(self._subagent_middleware(
                    children,
                    parent_model=spec.get("model") or model,
                    parent_tools=spec["tools"],
                    backend=backend,
                    own_gates=own_gates,
                    permissions=permissions,
                    depth=2,
                ))
                spec["system_prompt"] = delegating_subagent_prompt(spec.get("system_prompt"))
            spec["middleware"] = self._ensure_platform_middleware(stack)
            prepared.append(spec)
        if not any(isinstance(s, Mapping) and s.get("name") == GENERAL_PURPOSE_SUBAGENT["name"] for s in prepared):
            prepared.insert(0, self._general_purpose_subagent(model, inherited))
        return prepared


    def _general_purpose_subagent(self, model: Any, tools: Sequence[Any]) -> dict[str, Any]:
        """deepagents' general-purpose sub-agent, declared rather than auto-added,
        so it too runs without ``ask_user`` and with the platform middleware.
        Same name, description, prompt, model and skills as the one deepagents
        would add; as a declared spec it gets the same base stack."""
        spec: dict[str, Any] = {
            **GENERAL_PURPOSE_SUBAGENT,
            "model": model,
            "tools": list(tools),
            "middleware": self._ensure_platform_middleware([]),
        }
        if self.skills_paths:
            spec["skills"] = list(self.skills_paths)
        return spec


    def _subagent_middleware(
        self,
        children: Sequence[Any],
        *,
        parent_model: Any,
        parent_tools: Sequence[Any],
        backend: Any,
        own_gates: Mapping[str, Any] | None,
        permissions: list[Any],
        depth: int,
    ) -> SubAgentMiddleware:
        """The ``task`` tool of a sub-agent that has sub-agents of its own."""
        return SubAgentMiddleware(
            backend=backend,
            subagents=[
                child if "runnable" in child else self._nested_subagent(
                    child,
                    parent_model=parent_model,
                    parent_tools=parent_tools,
                    backend=backend,
                    own_gates=own_gates,
                    permissions=permissions,
                    depth=depth,
                )
                for child in children
            ],
        )


    def _nested_subagent(
        self,
        raw: Mapping[str, Any],
        *,
        parent_model: Any,
        parent_tools: Sequence[Any],
        backend: Any,
        own_gates: Mapping[str, Any] | None,
        permissions: list[Any],
        depth: int,
    ) -> dict[str, Any]:
        """A fully built spec for a sub-agent at ``depth`` ≥ 2.

        ``SubAgentMiddleware`` runs a spec as given, so everything deepagents
        adds at depth 1 is added here, in the same order — planning,
        filesystem with the workspace's write-deny rules, summarization,
        PatchToolCalls (whose marker binds the sub-agent's stream), the spec's
        own middleware, its own ``task`` tool if it has sub-agents, prompt
        caching — and then the platform middleware. Its model defaults to the
        one above it, its tools to the ones above it (never ``ask_user``), its
        approval gates to the run's, re-resolved for its tools.
        """
        spec = dict(raw)
        children = spec.pop(SUBAGENTS_KEY, None) or []
        model = spec.get("model") or parent_model
        resolved_model = resolve_model(model)
        tools = _without_ask_user(spec["tools"]) if "tools" in spec else list(parent_tools)
        gates = _merge_fs_interrupt_on(
            _build_interrupt_on_from_permissions(permissions),
            self._subagent_gates(tools, spec.get("interrupt_on"), own_gates),
        )
        stack: list[Any] = [
            TodoListMiddleware(),
            FilesystemMiddleware(backend=backend, _permissions=permissions),
            create_summarization_middleware(resolved_model, backend),
            PatchToolCallsMiddleware(),
            *(spec.get("middleware") or []),
        ]
        system_prompt = spec.get("system_prompt", "")
        if children:
            stack.append(self._subagent_middleware(
                children,
                parent_model=model,
                parent_tools=tools,
                backend=backend,
                own_gates=own_gates,
                permissions=permissions,
                depth=depth + 1,
            ))
            system_prompt = delegating_subagent_prompt(system_prompt)
        stack.append(AnthropicPromptCachingMiddleware(unsupported_model_behavior="ignore"))
        built: dict[str, Any] = {
            "name": spec["name"],
            "description": spec.get("description", ""),
            "system_prompt": system_prompt,
            "model": resolved_model,
            "tools": tools,
            "middleware": self._ensure_platform_middleware(stack),
        }
        if gates:
            built["interrupt_on"] = gates
        return built


    def _subagent_gates(
        self,
        tools: Sequence[Any],
        spec_gates: Mapping[str, Any] | None,
        own_gates: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """A sub-agent's approval gates: the run's layers, with its own spec's
        gates on top of the agent's — then the user's choices and the locked
        gates, exactly as for the main agent, so no spec can clear a gate the
        platform mandates."""
        return resolve_interrupt_on(
            tools,
            own_gates={**(own_gates or {}), **(spec_gates or {})},
            approvals=self.tool_config.approvals,
            agent_slug=self.name,
        )



    # ---------------------------------------------------------------------
    # Lifecycle hooks
    # ---------------------------------------------------------------------
    def load_skills(self) -> list[str | tuple[str, str]]:
        """Skill sources the agent should expose at startup, in precedence order.

        ``/skills/`` (tier ②) resolves against this (user, agent)'s
        ``agent_skills`` rows — ONLY the skills the user explicitly enabled for
        the pair. The central registry is never mounted; users browse it in the
        Skills tab.

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
        sources: list[str | tuple[str, str]] = [("/skills/", "Your")]
        if self._has_default_skills:
            sources.append(("/default_skills/", "Built-in"))
        return sources


    @property
    def _has_default_skills(self) -> bool:
        """Whether this run mounts ``/default_skills/`` at all.

        Two sources satisfy it — a bundled directory for a platform agent, pool
        names for a user-authored one — so the mount, the write-deny rule and
        the prompt section all derive from this single answer. Testing the
        directory alone would drop a custom agent's whole tier ① and, worse,
        leave the prompt advertising a route the run did not mount.
        """
        return self.default_skills_dir is not None or bool(self.declared_skills)


    @property
    def declared_skills(self) -> tuple[str, ...]:
        """Tier ① skill names resolved from the user's pool, for agents whose
        shipped skills are pool entries rather than a bundled directory.

        Empty by default: an agent defined in code declares its skills in code.
        Declarative agents override it.
        """
        return ()


    @property
    def default_skills_dir(self) -> Optional[Path]:
        """Directory of skills this agent ships with, or ``None`` for none.

        A policy hook, like :attr:`reference_dir`. ``None`` by default: an agent
        defined in code declares its skills in code. A **platform** declarative
        agent resolves it straight out of its global folder; a user-authored one
        has no folder and uses :attr:`declared_skills` instead.
        """
        return None


    def load_agent_md(self) -> list[str]:
        """This (user, agent)'s memory index file.

        Resolved through the CompositeBackend ``/memories/`` route, a view over
        this (user, agent)'s ``agent_memories`` rows that derives the index on
        read; the ``remember`` tool maintains the entries (one summary line per
        memory, pointing at ``entries/``) and deepagents' MemoryMiddleware
        injects it as always-on context.

        Returns ``[]`` when memory is disabled for this run (``self.use_memory``
        False, threaded from the user's preference) so ``create_deep_agent``
        receives no always-on memory file — paired with omitting the
        ``/memories/`` mount in ``_build_composite_backend``.
        """
        if not self.use_memory:
            return []
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
