"""Per-agent tool listing (Agents-tab business logic).

Two kinds of tool, one row shape:

* **builtin** — the prebuilt tools every deep agent has (``harness/tools/builtins.py``).
  Never enable/disable-able: the framework ones are constructed inside
  ``create_deep_agent`` where we cannot reach them, and the native ones are
  governed by the Personalization prefs. Their approval *is* configurable.
* **mcp** — declared in ``agent.yaml`` or available from the gateway. Both axes
  configurable.

This service reports the **baseline**: what exists, what the agent declares, and
what it gates before any user choice. The user's own choices live in ``chat_db``
and are overlaid by the bridge.

Only deep agents have this model; LangGraph agents return no rows.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Set

from core.settings import settings
from harness.tools.builtins import BUILTIN_TOOLS, resolve_availability
from harness.tools.registry import NATIVE_TOOLS, native_hitl_defaults
from schema import AgentToolRow
from utils.agents import resolve_agent_definition
from utils.mcp_tools import build_tool_cache_key, get_cached_tool_manifests_map


def _resolve_for_user(agent_slug: str, user_id: str):
    """A platform agent, else one this user authored.

    Platform first is unambiguous: agent creation refuses a slug that collides
    with a platform agent (see ``plans/01-custom-agents-per-user.md``).
    """
    return resolve_agent_definition(agent_slug) or resolve_agent_definition(agent_slug, user_id)


def _is_deep(definition) -> bool:
    return (definition.manifest or {}).get("type") == "deep agent"


def baseline_gates(definition) -> Set[str]:
    """Tool names gated before the user has any say.

    Three policy layers: builtins that default to gated, the gates a code-defined
    agent class declares, and a spec-driven agent's ``agent.yaml`` ``hitl`` map.
    Keyed by **tool name**, matching ``interrupt_on``.

    Read from the agent *class*, never a built instance — building one needs a
    model and the full mount stack.
    """
    gates = set(native_hitl_defaults())
    cls = getattr(definition, "cls", None)
    if cls is not None:
        gates.update(n for n, on in (getattr(cls, "hitl_gates", None) or {}).items() if on)
    spec = getattr(definition, "spec", None)
    if spec is not None:
        gates.update(n for n, on in (spec.hitl or {}).items() if on)
    return gates


def _builtin_rows(gates: Set[str], *, use_memory: bool, search_past_convs: bool) -> List[AgentToolRow]:
    """Prebuilt rows, in roster order. Descriptions for native tools come from
    the registry, which owns them."""
    rows: List[AgentToolRow] = []
    for tool in BUILTIN_TOOLS:
        available, reason = resolve_availability(
            tool,
            use_memory=use_memory,
            search_past_convs=search_past_convs,
            has_conversation=True,
            sandbox_enabled=settings.filesystem.sandbox_execution_enabled,
        )
        native = NATIVE_TOOLS.get(tool.name)
        rows.append(
            AgentToolRow(
                key=tool.name,
                name=tool.name,
                description=tool.description or (native.description if native else ""),
                kind="builtin",
                group=tool.group,
                declared=True,
                available=available,
                unavailableReason=reason,
                enabled=True,
                approval=tool.name in gates,
                approvalLocked=tool.locked,
            )
        )
    return rows


def _mcp_rows(definition, gates: Set[str]) -> List[AgentToolRow]:
    """Declared MCP tools first, then everything else the gateway exposes.

    A cold manifest cache simply yields no available rows; the declared ones
    still list.
    """
    rows: Dict[str, AgentToolRow] = {}
    manifests = get_cached_tool_manifests_map()

    spec = getattr(definition, "spec", None)
    for ref in getattr(spec, "tools", None) or []:
        if getattr(ref, "native", None):
            continue
        key = build_tool_cache_key(ref.server_id or "", ref.tool_name or "")
        manifest = manifests.get(key)
        name = ref.tool_name or key
        rows[key] = AgentToolRow(
            key=key,
            name=name,
            description=(getattr(manifest, "description", "") or "") if manifest else "",
            kind="mcp",
            group=ref.server_id or "mcp",
            declared=True,
            available=True,
            unavailableReason=None,
            enabled=True,
            approval=name in gates,
            approvalLocked=False,
        )

    for key, manifest in manifests.items():
        if key in rows:
            continue
        name = getattr(manifest, "tool_name", "") or key
        rows[key] = AgentToolRow(
            key=key,
            name=name,
            description=getattr(manifest, "description", "") or "",
            kind="mcp",
            group=getattr(manifest, "server_id", "") or "mcp",
            declared=False,
            available=True,
            unavailableReason=None,
            enabled=False,
            approval=name in gates,
            approvalLocked=False,
        )

    return sorted(rows.values(), key=lambda r: (not r.declared, r.group.lower(), r.name.lower()))


def list_agent_tools(
    user_id: str,
    agent_slug: str,
    *,
    use_memory: bool = True,
    search_past_convs: bool = False,
) -> Optional[List[AgentToolRow]]:
    """Every tool this agent can have, or ``None`` when the agent is unknown.

    ``use_memory`` / ``search_past_convs`` are the caller's preferences; they
    decide whether two native builtins are present for this user, and are passed
    in because this service does not own them.
    """
    definition = _resolve_for_user(agent_slug, user_id)
    if definition is None:
        return None
    if not _is_deep(definition):
        return []

    gates = baseline_gates(definition)
    return _builtin_rows(
        gates, use_memory=use_memory, search_past_convs=search_past_convs
    ) + _mcp_rows(definition, gates)
