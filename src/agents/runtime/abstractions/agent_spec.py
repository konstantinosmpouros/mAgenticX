"""Declarative agent specification — the parsed, validated ``agent.yaml``.

This is the contract the platform's declarative-agent system is built on: a
folder holding an ``agent.yaml`` (this schema) + an ``AGENT.md`` system prompt
is enough to register and run a deep agent — no Python subclass, no rebuild.
See ``docs/draft/platform-restructure-change-plan.md`` (§3).

Two layers of validation:

* **Structural (here):** strict Pydantic, ``extra="forbid"`` so a typo or an
  unsupported key fails loudly instead of silently changing behaviour; slug
  shape; and the tool-selector form (MCP vs native).
* **Referential (elsewhere, at load time):** model ids against the model
  registry, native tool names against the native-tool registry, and prompt
  paths confined to the agent's own directory (traversal-guarded). Those
  registries don't exist at import time, so that check lives in the loader
  (``runtime.abstractions.yaml_agent`` / the discoverer), not in this module — see
  :meth:`AgentSpec.reference_errors` for the hook.
"""
from __future__ import annotations

import re
from typing import Callable, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


# Kebab-case: lowercase alnum groups joined by single hyphens. Doubles as a
# path-safety guard — a slug is used as an on-disk directory name.
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

# The only agent type expressible in YAML for v1. LangGraph agents stay Python
# until a declarative graph interpreter exists (plan §7).
AgentSpecType = Literal["deep_agent"]


class ToolRef(BaseModel):
    """A single entry in an agent's tool list.

    Exactly one of two mutually exclusive forms:

    * **MCP tool** — ``server_id`` + ``tool_name``; resolved against the live
      MCP gateway manifest at build time.
    * **Native tool** — ``native``; resolved by name against the in-image
      native-tool registry.
    """

    model_config = ConfigDict(extra="forbid")

    server_id: Optional[str] = None
    tool_name: Optional[str] = None
    native: Optional[str] = None

    @model_validator(mode="after")
    def _exactly_one_form(self) -> "ToolRef":
        is_mcp = bool(self.server_id) and bool(self.tool_name)
        is_native = bool(self.native)
        # XOR: reject both-forms and neither-form.
        if is_mcp == is_native:
            raise ValueError(
                "ToolRef must be either an MCP tool ({server_id, tool_name}) "
                "or a native tool ({native}) — not both, not neither."
            )
        return self

    @property
    def is_native(self) -> bool:
        return self.native is not None

    def key(self) -> str:
        """Stable identity used for dedupe and per-agent disable matching."""
        return f"native::{self.native}" if self.is_native else f"{self.server_id}::{self.tool_name}"


class SubAgentSpec(BaseModel):
    """A nested sub-agent. Maps 1:1 to ``deepagents.SubAgent``.

    ``prompt`` is a path to a markdown file relative to the agent directory
    (e.g. ``./subagents/researcher.md``) or an inline string. ``model`` falls
    back to ``AgentSpec.model.subagents[name]`` and then the main model when
    omitted.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    prompt: str
    model: Optional[str] = None
    tools: list[ToolRef] = Field(default_factory=list)


class ModelSpec(BaseModel):
    """Models an agent uses: one required main model + optional per-sub-agent
    overrides keyed by sub-agent name (e.g. ``{researcher: openai:gpt-4o}``)."""

    model_config = ConfigDict(extra="forbid")

    main: str
    subagents: dict[str, str] = Field(default_factory=dict)


class AgentSpec(BaseModel):
    """Top-level declarative agent definition — the parsed ``agent.yaml``.

    Field → runtime mapping (see the current class attributes in
    ``runtime/abstractions/base_agent.py`` and ``BaseAgent.manifest()``):

    ==========  ===========================================
    spec field  runtime attribute (today)
    ==========  ===========================================
    ``id``      ``agent_id``
    ``slug``    ``name``   (registry key + folder name)
    ``name``    ``label``  (display name)
    ``version`` ``version``
    ``type``    ``AgentType``
    ``prompt``  ``instructions`` / ``system_prompt``
    ``model``   ``create_deep_agent(model=..., subagents=...)``
    ``tools``   the agent's declared tool set (native ∪ MCP)
    ``hitl``    ``interrupt_on={...}``
    ==========  ===========================================
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    slug: str
    name: str
    version: str
    type: AgentSpecType
    description: str = ""
    icon: str = ""
    # Path to the markdown system prompt (``./AGENT.md``) or an inline string.
    prompt: str
    model: ModelSpec
    # Per-agent default for the user's ``use_memory`` toggle.
    memory: bool = True
    # The agent's declared tools; the user may only *disable* a subset per
    # agent (plan §5). Empty = builtins/sub-agents only.
    tools: list[ToolRef] = Field(default_factory=list)
    # Skills enabled by default; refs into the global registry or the user pool.
    skills: list[str] = Field(default_factory=list)
    subagents: list[SubAgentSpec] = Field(default_factory=list)
    # Tools gated behind human approval, e.g. {"write_file": true, "task": true}.
    hitl: dict[str, bool] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_slug(self) -> "AgentSpec":
        if not SLUG_RE.match(self.slug):
            raise ValueError(
                f"Invalid agent slug {self.slug!r}: must be kebab-case matching {SLUG_RE.pattern}."
            )
        return self

    def all_model_ids(self) -> list[str]:
        """Every model id referenced (main + per-name + sub-agent overrides).

        Used by the loader to validate against the model registry."""
        ids = {self.model.main, *self.model.subagents.values()}
        ids.update(sa.model for sa in self.subagents if sa.model)
        return sorted(i for i in ids if i)

    def native_tool_names(self) -> list[str]:
        """Every native-tool name referenced (agent + sub-agent tool lists).

        Used by the loader to validate against the native-tool registry."""
        names = {t.native for t in self.tools if t.is_native}
        for sa in self.subagents:
            names.update(t.native for t in sa.tools if t.is_native)
        return sorted(n for n in names if n)

    def reference_errors(
        self,
        *,
        is_known_model: Callable[[str], bool],
        is_known_native_tool: Callable[[str], bool],
    ) -> list[str]:
        """Referential validation hook run by the loader once the registries
        exist. Returns a list of human-readable errors (empty = valid), so the
        discoverer can reject an agent with a clear message instead of failing
        deep inside ``build_deep_agent``.
        """
        errors: list[str] = []
        for model_id in self.all_model_ids():
            if not is_known_model(model_id):
                errors.append(f"unknown model id: {model_id!r}")
        for tool_name in self.native_tool_names():
            if not is_known_native_tool(tool_name):
                errors.append(f"unknown native tool: {tool_name!r}")
        return errors


__all__ = ["ToolRef", "SubAgentSpec", "ModelSpec", "AgentSpec", "AgentSpecType"]
