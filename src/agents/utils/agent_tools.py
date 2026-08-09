"""Per-agent tool listing + toggling (Agents-tab business logic).

Computes the tool rows shown in the UI's Agents tab — the tools a given agent
can use, each annotated with its per-(user, agent) disabled state — and applies
a toggle. The disabled set is the same one the runtime subtracts at build time
(``runtime.filesystem.tool_prefs`` ↔ ``DeepAgent._apply_tool_disables``), so what
the user sees here is exactly what the agent gets.

Tool identity is the canonical cache key (``utils.build_tool_cache_key`` /
``get_tool_cache_key``): ``<server>/<tool>`` for MCP, the bare name for native
tools — matching the resolver so a disable here removes the right tool there.
Only **deep agents** have this tool model; LangGraph agents return no rows.
"""
from __future__ import annotations

from typing import List, Optional

from observability import get_logger
from runtime.filesystem.tool_prefs import read_disabled_tools, set_tool_disabled
from runtime.tools.registry import native_catalog
from schemas import AgentToolRow
from utils.agents import AGENT_REGISTRY
from utils.mcp_tools import build_tool_cache_key, get_cached_tool_manifests_map

logger = get_logger(__name__)


def list_agent_tools(user_id: str, agent_slug: str) -> Optional[List[AgentToolRow]]:
    """Tool rows for (user, agent), or ``None`` when the agent is unknown.

    Includes the always-on native builtins (deep agents only) plus the agent's
    spec-declared tools (YAML agents). Deduped by key; each row carries the
    current disabled flag.
    """
    definition = AGENT_REGISTRY.get(agent_slug)
    if definition is None:
        return None

    disabled = read_disabled_tools(user_id, agent_slug)
    rows: dict[str, AgentToolRow] = {}

    native_by_name = {n["name"]: n for n in native_catalog()}
    is_deep = (definition.manifest or {}).get("type") == "deep agent"

    # Always-on native builtins (deep agents only — LangGraph agents don't use them).
    if is_deep:
        for meta in native_catalog():
            if not meta.get("autoAttach"):
                continue
            key = meta["name"]
            rows[key] = AgentToolRow(
                key=key, name=meta["name"], description=meta.get("description", ""),
                source="native", disabled=key in disabled,
            )

    # Spec-declared tools (declarative/YAML agents).
    spec = getattr(definition, "spec", None)
    if spec is not None:
        mcp_map = get_cached_tool_manifests_map()
        for tool in spec.tools:
            if getattr(tool, "native", None):
                key = tool.native
                meta = native_by_name.get(key)
                rows[key] = AgentToolRow(
                    key=key, name=key, description=(meta.get("description", "") if meta else ""),
                    source="native", disabled=key in disabled,
                )
            else:
                key = build_tool_cache_key(tool.server_id or "", tool.tool_name or "")
                manifest = mcp_map.get(key)
                rows[key] = AgentToolRow(
                    key=key, name=(tool.tool_name or key),
                    description=(getattr(manifest, "description", "") or "") if manifest else "",
                    source="mcp", disabled=key in disabled,
                )

    return list(rows.values())


def toggle_agent_tool(
    user_id: str, agent_slug: str, tool_key: str, disabled: bool
) -> Optional[List[AgentToolRow]]:
    """Set the disabled state of one tool for (user, agent); return refreshed
    rows, or ``None`` when the agent is unknown."""
    if agent_slug not in AGENT_REGISTRY:
        return None
    set_tool_disabled(user_id, agent_slug, tool_key, disabled)
    return list_agent_tools(user_id, agent_slug)


__all__ = ["list_agent_tools", "toggle_agent_tool"]
