"""Which tools a run has, and which of them stop for approval.

The counterpart to ``builtins.py`` (what the prebuilt tools *are*) and
``registry.py`` (how a native tool is built). This module owns the decisions
made *about* a tool set at build time — resolving the user's choices, merging
the approval layers, and keeping MCP tools out of names the framework reserves.

It lived on ``DeepAgent`` and ``BaseAgent`` before. That put four layers of
approval policy inside a 100-line assembler, where the ordering that makes a
locked gate un-clearable was a comment in the middle of a method rather than a
named function anyone could find or test on its own.

Nothing here touches an agent instance: every function takes what it needs and
returns a value, so the rules can be driven directly.
"""
from __future__ import annotations

import types
from typing import Any, Mapping, Protocol, Sequence

from core.logging import get_logger
from harness.tools.builtins import BUILTIN_BY_NAME, builtin_hitl_defaults, locked_gates
from utils import get_tool_cache_key

logger = get_logger(__name__)


class NamedTool(Protocol):
    """The only thing this module needs of a tool: what it is called.

    A Protocol rather than the concrete LangChain class, because the tool set
    mixes framework builtins, our native tools and live MCP tools, and the
    rules below care about none of that — only the name and its cache key.
    """

    name: str


def key_set(value: Any) -> frozenset[str]:
    """A clean set of non-empty tool keys from whatever the run config carried.

    The config crosses a service boundary as JSON, so a field can legitimately be
    absent, null, or a list with junk in it. Anything unparseable degrades to
    empty — the safe default, since it means the agent's declared baseline rather
    than a silently emptied tool set.
    """
    if not isinstance(value, (list, tuple, set)):
        return frozenset()
    return frozenset(k for k in value if isinstance(k, str) and k)


def approval_map(value: Any) -> Mapping[str, bool]:
    """A clean ``{tool key: wanted}`` map from whatever the run config carried.

    Same coercion stance as :func:`key_set`: anything unparseable degrades to no
    opinion, which means the agent's own gating rather than a guess.
    """
    if not isinstance(value, Mapping):
        return types.MappingProxyType({})
    return types.MappingProxyType(
        {k: bool(v) for k, v in value.items() if isinstance(k, str) and k and isinstance(v, bool)}
    )


def strip_reserved_names(
    tools: Sequence[NamedTool], *, agent_slug: str
) -> list[NamedTool]:
    """Drop live MCP tools whose name collides with a prebuilt one.

    A gateway is free to expose a tool called ``write_file``. If one reached the
    agent it would shadow the framework's, and every approval gate keyed on that
    name would point at the wrong tool — an approval control that looks armed
    and guards nothing.
    """
    reserved = {name.lower() for name in BUILTIN_BY_NAME}
    kept: list[NamedTool] = []
    excluded: list[str] = []

    for tool in tools:
        raw = getattr(tool, "name", "")
        name = raw.strip() if isinstance(raw, str) else str(raw or "").strip()
        if name.lower() in reserved:
            excluded.append(name)
            continue
        kept.append(tool)

    if excluded:
        logger.info(
            "deep_agent_reserved_tools_excluded",
            "Deep agent excluded reserved internal tools from MCP attachment",
            agent_slug=agent_slug,
            excluded_tools=sorted(set(excluded)),
        )
    return kept


def user_gates(
    tools: Sequence[NamedTool],
    approvals: Mapping[str, bool],
    *,
    agent_slug: str,
) -> dict[str, bool]:
    """Approval gates this user asked for, keyed the way ``interrupt_on`` is.

    The Agents tab speaks in canonical cache keys (``arxiv/download_paper``),
    but ``interrupt_on`` is keyed by the tool's *own* name — and MCP tool names
    arrive from the gateway unprefixed. Writing a cache key straight through
    would match nothing and produce a gate that looks armed in the UI and
    silently never fires, the worst failure an approval control can have.

    So MCP keys are resolved against the live tools rather than parsed, and
    builtin names — which are their own key, and are never in ``tools`` because
    the framework builds them — pass through.

    Values are the user's explicit choice, so ``False`` means "clear the gate
    the baseline sets": a prebuilt tool can default to gated.
    """
    if not approvals:
        return {}

    gates = {
        tool.name: approvals[get_tool_cache_key(tool)]
        for tool in tools
        if getattr(tool, "name", None) and get_tool_cache_key(tool) in approvals
    }
    gates.update({n: v for n, v in approvals.items() if n in BUILTIN_BY_NAME})

    if gates:
        logger.info(
            "agent_tools_user_gated",
            "Applied user-requested approval gates for (user, agent)",
            agent_slug=agent_slug,
            gated_count=len(gates),
        )
    return gates


def resolve_interrupt_on(
    tools: Sequence[NamedTool],
    *,
    own_gates: Mapping[str, bool] | None,
    approvals: Mapping[str, bool],
    agent_slug: str,
) -> dict[str, bool]:
    """Merge the four approval layers into one ``interrupt_on`` map.

    Order is the whole contract, lowest priority first:

    1. ``builtin_hitl_defaults()`` — the platform's baseline for prebuilt tools
    2. ``own_gates`` — what this agent declares (spec ``hitl:`` or the class attr)
    3. the user's per-(user, agent) choices, which may **add or clear** a gate
    4. ``locked_gates()`` — mandated gates, applied last

    Step 4 is last so no layer beneath it can clear a mandated gate: a user
    switching off approval for ``execute`` must not be able to succeed.
    """
    resolved = {**builtin_hitl_defaults(), **(own_gates or {})}
    for name, wanted in user_gates(tools, approvals, agent_slug=agent_slug).items():
        if wanted:
            resolved[name] = True
        else:
            resolved.pop(name, None)
    resolved.update(locked_gates())
    return resolved


def trust_level(tools: Sequence[NamedTool]) -> str:
    """Whether this run could reach content nobody on our side authored.

    A durable memory is future context: an entry written after the agent read a
    poisoned page behaves like a stored prompt injection. Recording *that a run
    could have* read external content is what makes such an entry findable
    afterwards.

    Deliberately coarse. It is per-RUN, not per-turn, and it keys off the MCP
    tool set (web search, arXiv and the rest) because that is the external
    surface this service actually exposes. It is a review signal, never an
    authorization decision — the enforcement, if any, belongs in retrieval.
    """
    return "untrusted" if tools else "user-derived"


__all__ = [
    "NamedTool",
    "approval_map",
    "key_set",
    "resolve_interrupt_on",
    "strip_reserved_names",
    "trust_level",
    "user_gates",
]
