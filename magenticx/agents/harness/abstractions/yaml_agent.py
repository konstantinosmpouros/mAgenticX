"""``YamlDeepAgent`` — a single, generic ``DeepAgent`` built from an
:class:`~harness.abstractions.agent_spec.AgentSpec` instead of a bespoke Python
subclass.

This is what makes agents declarative: a spec is parsed into an ``AgentSpec``
and handed to this class, which reads its identity, prompt, models, tools,
sub-agents and HITL gates from it and feeds them into the same
``build_deep_agent()`` every Python deep agent uses. No per-agent Python. See
``docs/draft/platform-restructure-change-plan.md`` §4.

**One class, two homes.** A *platform* agent's definition is a folder in the
image, so it arrives as ``source_dir`` and its prompts are read off disk. A
*user-authored* one is rows in ``agent_runtime``, so it arrives as
``owner_user_id`` plus an already-loaded ``definition_files`` map. Which of the
two applies used to be inferred from the parent directory's name; it is now
stated, because a user agent has no directory to inspect. Everything downstream
— the ``/reference/`` mount, tier ① skills — branches on that one answer.

Identity (``name``/``agent_id``/``label``/…) is set per **instance** (a single
class serves every YAML agent), so ``self.name`` — read throughout the base for
the workspace mounts, builtins, and ``build_deep_agent(name=...)`` — resolves to
the spec's slug. The registry manifest is built from the spec by
``utils.declarative.manifest_from_spec`` (the base ``classmethod`` reads
class attrs, which a single shared class can't carry per agent).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, Optional

from deepagents import SubAgent

from harness.abstractions.deep_agent import DeepAgent
from harness.abstractions.agent_spec import AgentSpec, SubAgentSpec, ToolRef
from utils.declarative import read_prompt, resolve_prompt
from harness.filesystem import layout
from harness.tools.registry import NativeToolContext, resolve_native_tool
from core.logging import get_logger

logger = get_logger(__name__)


class YamlDeepAgent(DeepAgent):
    """A deep agent whose whole definition comes from an ``AgentSpec``."""

    def __init__(
        self,
        spec: AgentSpec,
        source_dir: Path | None = None,
        *,
        owner_user_id: str | None = None,
        definition_files: Mapping[str, str] | None = None,
        config: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(config=config)
        self._spec = spec
        self._source_dir = Path(source_dir) if source_dir is not None else None
        # The one thing that decides where this agent's definition lives.
        # Previously inferred from `source_dir.parent.name == "custom_agents"`,
        # which stopped being knowable once a user agent had no directory — and
        # was always a fragile way to ask "who owns this?".
        self._owner_user_id = owner_user_id
        self._definition_files = dict(definition_files or {})

        # Per-instance identity (overrides the shared class attributes) so every
        # `self.name`/`self.label`/… read across the base resolves to this spec.
        self.name = spec.slug
        self.agent_id = spec.id
        self.label = spec.name
        self.version = spec.version
        self.description = spec.description
        self.icon = spec.icon
        self.instructions = self._read_prompt(spec.prompt)

        # The agent's declared tools come from the spec, NOT the request. MCP
        # refs seed the config-tool filter so `attach_tools` keeps only these
        # from the live gateway manifest; native refs are resolved at build.
        mcp_refs = [t for t in spec.tools if not t.is_native]
        self.config_tools = [
            {"server_id": t.server_id or "", "tool_name": t.tool_name or ""} for t in mcp_refs
        ]
        self.config_tool_names = [
            self._build_tool_key_from_config(entry) for entry in self.config_tools
        ]
        # The user's extra gateway tools are NOT unioned here: that happens in
        # BaseAgent._filter_live_tools, so a code-defined deep agent honours them
        # too. `config_tool_names` stays exactly what the spec declares.
        self._native_tool_names: list[str] = [t.native for t in spec.tools if t.is_native and t.native]

        # The agent's `memory:` is the default `use_memory` — but an explicit
        # per-run user preference (threaded via context) still wins.
        if "use_memory" not in self.context:
            self.use_memory = spec.memory

    # ------------------------------------------------------------------
    @property
    def is_user_authored(self) -> bool:
        """Whether this agent's definition belongs to a user rather than the image."""
        return self._owner_user_id is not None

    def _read_prompt(self, value: str) -> str:
        """Resolve a prompt reference against whichever store this agent uses.

        Both branches treat a non-path value as an inline prompt, so a spec means
        the same thing either way; only the lookup differs. Constructing the
        agent does **no I/O** for a user-authored one — the files were fetched
        once, with the spec, by the loader — which is what lets ``__init__`` stay
        synchronous now that the definition lives behind an async store.
        """
        if self.is_user_authored:
            return resolve_prompt(value, self._definition_files)
        if self._source_dir is None:
            return value
        return read_prompt(value, self._source_dir)

    @property
    def reference_dir(self) -> Path | None:
        """``/reference/`` for a **platform** agent — its folder in the image.

        A declarative agent's definition is prompts and config — the loader
        accepts no other file type — so exposing it costs nothing and makes
        bundled material (notes, checklists, examples the prompt refers to)
        actually readable. Without it, a file sitting next to ``AGENT.md`` is
        inert: only ``prompt`` and the sub-agent prompts are ever read, and those
        are read once at build time.

        ``None`` for a user-authored agent, which has no folder — see
        :attr:`reference_namespace`.
        """
        return None if self.is_user_authored else self._source_dir

    @property
    def reference_namespace(self) -> tuple[str, ...] | None:
        """``/reference/`` for a **user-authored** agent — its rows.

        Same read-only mount, resolved per read from ``agent_definition_files``
        rather than from a directory that would have to be kept in step with the
        database.
        """
        if not self.is_user_authored:
            return None
        return (self._owner_user_id or "", self.name)


    @property
    def default_skills_dir(self) -> Optional[Path]:
        """The skills this agent ships with, resolved from where it was defined.

        A **platform** agent's live in its own global folder and are mounted
        straight from there — build-time content, identical for every user and
        impossible to tamper with.

        A **user-authored** agent has no such folder. Its tier ① is its spec's
        ``skills:`` list resolved against the author's own pool, which the store
        serves; :attr:`declared_skills` carries those names instead. Returning
        ``None`` here is therefore correct for a custom agent, not a gap.
        """
        if not self._spec.skills or self.is_user_authored:
            return None
        path = layout.global_agent_default_skills_root(self.name)
        return path if path.is_dir() and any(path.iterdir()) else None


    @property
    def declared_skills(self) -> tuple[str, ...]:
        """Tier ① skill names for a user-authored agent, resolved from the pool.

        Empty for a platform agent — its tier ① is a directory, not pool names —
        and empty during registry warmup, where there is no user whose pool the
        names could be resolved against.
        """
        if not self._spec.skills or not self.is_user_authored:
            return ()
        if not (self.context or {}).get("user_id"):
            return ()
        return tuple(self._spec.skills)


    def _native_ctx(self) -> Optional[NativeToolContext]:
        """Context for building native tools, or None during registry warmup
        (no user_id — same guard as ``_builtin_tools``)."""
        user_id = (self.context or {}).get("user_id")
        if not user_id:
            return None
        return NativeToolContext(
            user_id=user_id,
            agent_slug=self.name,
            conversation_id=self.context.get("conversation_id"),
            use_memory=self.use_memory,
            search_past_convs=bool(self.context.get("search_past_convs")),
        )

    def _resolve_native_tools(self, refs: list[ToolRef]) -> list[Any]:
        nctx = self._native_ctx()
        if nctx is None:
            return []
        resolved: list[Any] = []
        for ref in refs:
            if not ref.is_native or not ref.native:
                continue
            tool = resolve_native_tool(ref.native, nctx)
            if tool is not None:
                resolved.append(tool)
        return resolved

    # ------------------------------------------------------------------
    def register_subagents(self) -> list[SubAgent]:
        subagents: list[SubAgent] = []
        for sa in self._spec.subagents:
            mcp_refs = [t for t in sa.tools if not t.is_native]
            if mcp_refs:
                # Sub-agent MCP tools aren't filtered from the live manifest yet
                # (Phase 1 handles native + main-agent MCP). Surface it instead of
                # silently dropping.
                logger.warning(
                    "yaml_subagent_mcp_tools_ignored",
                    "Sub-agent MCP tools are not yet wired for YAML agents; ignoring",
                    agent_slug=self.name,
                    subagent=sa.name,
                )
            subagents.append(
                SubAgent(
                    model=self._resolve_subagent_model(sa),
                    name=sa.name,
                    description=sa.description,
                    system_prompt=self._read_prompt(sa.prompt),
                    tools=self._resolve_native_tools(sa.tools),
                )
            )
        return subagents

    def _resolve_subagent_model(self, sa: SubAgentSpec) -> str:
        """Sub-agent model: explicit → `model.subagents[name]` → main model."""
        return sa.model or self._spec.model.subagents.get(sa.name) or self._spec.model.main

    # ------------------------------------------------------------------
    def register_agent(self) -> Any:
        # `self.tools` already holds the agent's declared MCP tools (filtered
        # from the live manifest by attach_tools). Add the spec's native tools;
        # `build_deep_agent` then appends the always-on builtins.
        self.tools.extend(self._resolve_native_tools([t for t in self._spec.tools if t.is_native]))
        return self.build_deep_agent(
            model=self._spec.model.main,
            system_prompt=self.instructions,
            subagents=self.sub_agents,
            interrupt_on=self._spec.hitl,
        )


__all__ = ["YamlDeepAgent"]
