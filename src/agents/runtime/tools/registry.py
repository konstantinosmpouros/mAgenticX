"""Native-tool registry — the in-code catalog of platform (native) tools.

Native tools are Python tools that ship in the image (as opposed to MCP tools,
which arrive as a live manifest from the gateway). This registry is their single
source of truth: each tool registers its **metadata** (description, the AG-UI
events it emits, whether it is HITL-gated by default) plus a **builder** that
produces the per-run, context-bound LangChain tool. It exists so that

* a declarative ``agent.yaml`` can select a native tool **by name**
  (``{native: <name>}``) — resolved via :func:`resolve_native_tool`;
* the platform can present a **read-only catalog** of what tools exist
  (:func:`native_catalog`) without duplicating anything into YAML;
* the ``AgentSpec`` loader can validate ``{native: ...}`` refs
  (:func:`is_known_native_tool`);
* ``DeepAgent._builtin_tools`` can attach the always-on builtins from one place
  (:func:`build_auto_attach_tools`).

See ``docs/draft/platform-restructure-change-plan.md`` §5. Native tools are
platform-owned: adding one is a code change here, never a user upload.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from runtime.tools.create_skill import build_create_skill_tool
from runtime.tools.memory_search import build_memory_search_tool
from runtime.tools.present_artifact import build_present_artifact_tool
from runtime.tools.remember import build_remember_tool


@dataclass(frozen=True)
class NativeToolContext:
    """Per-run binding a native-tool builder needs. Assembled from the agent's
    ``self.context`` at build time; safe to hold identity because every request
    builds its own agent instance (nothing shared across users)."""

    user_id: str
    agent_slug: str
    conversation_id: Optional[str]
    use_memory: bool = True
    search_past_convs: bool = False


@dataclass(frozen=True)
class NativeToolDef:
    """A registered native tool: metadata + a context-bound builder.

    ``builder(ctx)`` returns the LangChain tool, or ``None`` when this run does
    not satisfy the tool's gate (e.g. ``remember`` when memory is off). Reserved
    deepagents names (``write_todos``, ``read_file`` …) are NOT registered here —
    those are provided by deepagents itself.
    """

    name: str
    description: str
    builder: Callable[[NativeToolContext], Optional[Any]]
    emits: tuple[str, ...] = ()
    hitl_default: bool = False
    # Auto-attach tools are given to every deep agent (subject to their gate),
    # not selected in `agent.yaml`. Non-auto tools are opt-in via `{native: ...}`.
    auto_attach: bool = False


# Registration order is preserved (dict insertion order) and is the order
# auto-attach tools are appended to a deep agent — kept identical to the old
# hand-written `_builtin_tools` (remember → search → present_artifact).
NATIVE_TOOLS: dict[str, NativeToolDef] = {}


def register_native_tool(defn: NativeToolDef) -> NativeToolDef:
    """Register a native tool. Raises on a duplicate name (fail-closed)."""
    if defn.name in NATIVE_TOOLS:
        raise ValueError(f"Native tool {defn.name!r} is already registered.")
    NATIVE_TOOLS[defn.name] = defn
    return defn


# --- Built-in native tools --------------------------------------------------
# Gate logic mirrors the previous DeepAgent._builtin_tools exactly:
#   remember               → attached when use_memory is on
#   search_past_conversations → attached when the user opted into search_past_convs
#   present_artifact       → attached whenever there is a conversation to point into
#   create_skill           → always attached (HITL-gated; writes to the user's pool)

register_native_tool(
    NativeToolDef(
        name="remember",
        description="Save a durable fact to this (user, agent)'s long-term memory.",
        auto_attach=True,
        builder=lambda ctx: (
            build_remember_tool(
                user_id=ctx.user_id,
                agent_slug=ctx.agent_slug,
                conversation_id=ctx.conversation_id,
            )
            if ctx.use_memory
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name="search_past_conversations",
        description="Semantically search the user's earlier conversations (opt-in).",
        auto_attach=True,
        builder=lambda ctx: (
            build_memory_search_tool(
                user_id=ctx.user_id,
                conversation_id=ctx.conversation_id,
            )
            if ctx.search_past_convs
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name="present_artifact",
        description="Designate a finished output/ file as a user-facing deliverable.",
        auto_attach=True,
        builder=lambda ctx: (
            build_present_artifact_tool(
                user_id=ctx.user_id,
                agent_slug=ctx.agent_slug,
                conversation_id=ctx.conversation_id,
            )
            if ctx.conversation_id
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name="create_skill",
        description="Author a reusable skill into the user's pool and enable it for this agent.",
        auto_attach=True,
        # HITL by default: this writes a new folder into the user's own
        # workspace, and the platform's stance on agent-initiated writes is
        # fail-closed. Relaxing this later is one flag; discovering it should
        # not have been open is not recoverable.
        hitl_default=True,
        builder=lambda ctx: build_create_skill_tool(
            user_id=ctx.user_id,
            agent_slug=ctx.agent_slug,
        ),
    )
)


# --- Public API -------------------------------------------------------------
def is_known_native_tool(name: str) -> bool:
    """Whether ``name`` is a registered native tool (used to validate specs)."""
    return name in NATIVE_TOOLS


def resolve_native_tool(name: str, ctx: NativeToolContext) -> Optional[Any]:
    """Build a native tool selected by an agent (``{native: name}``).

    Returns the bound tool, or ``None`` when unknown or gated off this run."""
    defn = NATIVE_TOOLS.get(name)
    return defn.builder(ctx) if defn is not None else None


def build_auto_attach_tools(ctx: NativeToolContext) -> list[Any]:
    """The always-on builtins every deep agent gets, in registration order,
    each subject to its own gate. ``DeepAgent._builtin_tools`` delegates here."""
    tools: list[Any] = []
    for defn in NATIVE_TOOLS.values():
        if not defn.auto_attach:
            continue
        tool = defn.builder(ctx)
        if tool is not None:
            tools.append(tool)
    return tools


def native_hitl_defaults() -> dict[str, bool]:
    """Approval gates every deep agent starts with, from ``hitl_default``.

    Merged UNDER an agent's own ``interrupt_on`` in ``build_deep_agent``, so a
    spec can still speak for itself while a tool that declares itself dangerous
    is gated by default rather than only when someone remembers to list it.
    Without this the flag was catalog metadata that gated nothing.
    """
    return {d.name: True for d in NATIVE_TOOLS.values() if d.hitl_default}


def native_catalog() -> list[dict[str, Any]]:
    """Read-only listing of every native tool for the inspection UI / catalog.

    Metadata only — never builders. Paired with the live MCP manifest by the
    bridge to form the full tool catalog."""
    return [
        {
            "name": d.name,
            "description": d.description,
            "emits": list(d.emits),
            "hitlDefault": d.hitl_default,
            "autoAttach": d.auto_attach,
            "source": "native",
        }
        for d in NATIVE_TOOLS.values()
    ]


__all__ = [
    "NativeToolContext",
    "NativeToolDef",
    "NATIVE_TOOLS",
    "register_native_tool",
    "is_known_native_tool",
    "resolve_native_tool",
    "build_auto_attach_tools",
    "native_catalog",
]
