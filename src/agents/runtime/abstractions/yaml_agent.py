"""``YamlDeepAgent`` — a single, generic ``DeepAgent`` built from an
:class:`~runtime.abstractions.agent_spec.AgentSpec` instead of a bespoke Python
subclass.

This is what makes agents declarative: the discoverer parses a folder's
``agent.yaml`` into an ``AgentSpec`` and hands it (plus the folder) to this
class, which reads its identity, prompt, models, tools, sub-agents, and HITL
gates from the spec and feeds them into the same ``build_deep_agent()`` every
Python deep agent uses. No per-agent Python. See
``docs/draft/platform-restructure-change-plan.md`` §4.

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

from runtime.abstractions.deep_agent import DeepAgent
from runtime.abstractions.agent_spec import AgentSpec, SubAgentSpec, ToolRef
from utils.declarative import read_prompt
from runtime.filesystem.tool_prefs import read_enabled_tools
from runtime.tools.registry import NativeToolContext, resolve_native_tool
from observability import get_logger

logger = get_logger(__name__)


class YamlDeepAgent(DeepAgent):
    """A deep agent whose whole definition comes from an ``AgentSpec``."""

    def __init__(
        self,
        spec: AgentSpec,
        source_dir: Path,
        *,
        config: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(config=config)
        self._spec = spec
        self._source_dir = Path(source_dir)

        # Per-instance identity (overrides the shared class attributes) so every
        # `self.name`/`self.label`/… read across the base resolves to this spec.
        self.name = spec.slug
        self.agent_id = spec.id
        self.label = spec.name
        self.version = spec.version
        self.description = spec.description
        self.icon = spec.icon
        self.instructions = read_prompt(spec.prompt, self._source_dir)

        # Convention-based asset discovery (agent-bundled skills/) resolves under
        # the agent's own folder, not the yaml_agent.py file.
        self._impl_dir = self._source_dir

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
        # Beyond the declared set, the user may enable extra gateway MCP tools for
        # this (user, agent) via the Agents tab. Union those keys in so the
        # live-manifest filter (attach_tools) keeps them too; a per-agent disable
        # is still subtracted later by _apply_tool_disables.
        user_id = (self.context or {}).get("user_id")
        if user_id:
            for key in read_enabled_tools(user_id, self.name):
                if key not in self.config_tool_names:
                    self.config_tool_names.append(key)
        self._native_tool_names: list[str] = [t.native for t in spec.tools if t.is_native and t.native]

        # The agent's `memory:` is the default `use_memory` — but an explicit
        # per-run user preference (threaded via context) still wins.
        if "use_memory" not in self.context:
            self.use_memory = spec.memory

    # ------------------------------------------------------------------
    @property
    def reference_dir(self) -> Path:
        """Mount the agent's own definition folder read-only at ``/reference/``.

        A declarative agent's folder is prompts and config — the loader accepts
        no other file type — so exposing it costs nothing and makes bundled
        material (notes, checklists, examples the prompt refers to) actually
        readable. Without this, a file sitting next to ``AGENT.md`` is inert:
        only ``prompt`` and the sub-agent prompts are ever read, and those are
        read once at build time.
        """
        return self._source_dir


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
                    system_prompt=read_prompt(sa.prompt, self._source_dir),
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
