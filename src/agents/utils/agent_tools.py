"""Per-agent tool listing + toggling (Agents-tab business logic).

Scope: **MCP tools only.** The Agents tab is where a user tunes which MCP tools
an agent may use — two groups of rows:

* **declared** — the MCP tools the agent's spec declares (``agent.yaml``). ON by
  default; the user may turn one OFF (added to the per-agent ``disabled`` set).
* **available** — every other MCP tool the gateway currently exposes. OFF by
  default; the user may turn one ON for this agent (added to the ``enabled``
  set). This is how a user grants an agent a tool it did not declare.

Native builtins are **deliberately not managed here**: ``remember`` and
``search_past_conversations`` are controlled by the user's Personalization prefs
(``use_memory`` / ``search_past_convs``), and ``present_artifact`` is always on
and can never be disabled. So they are never listed and never toggle-able —
``DeepAgent._apply_tool_disables`` also refuses to drop any native key.

Effective set the runtime builds: ``(declared_mcp ∪ enabled) − disabled`` — the
two override sets, owned by the bridge in ``chat_db`` and consumed by
``YamlDeepAgent`` (enabled → ``config_tool_names``) and
``DeepAgent._apply_tool_disables`` (disabled). Tool identity is the canonical
cache key so a toggle here removes/adds exactly the right live tool there.

Only **deep agents** have this tool model; LangGraph agents return no rows.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Set

from core.logging import get_logger
from harness.tools.registry import native_catalog
from schema import AgentToolRow
from utils.agents import resolve_agent_definition
from utils.mcp_tools import build_tool_cache_key, get_cached_tool_manifests_map

logger = get_logger(__name__)


def _resolve_for_user(agent_slug: str, user_id: str):
    """A platform agent, else one this user authored.

    These endpoints are already scoped to a user and don't carry an explicit
    owner id (unlike the inference path, where the bridge threads it). Trying
    platform first is unambiguous because agent creation refuses a slug that
    collides with a platform agent — see
    ``docs/plans/01-custom-agents-per-user.md``.
    """
    return resolve_agent_definition(agent_slug) or resolve_agent_definition(agent_slug, user_id)


def _native_keys() -> Set[str]:
    """Cache keys of the native builtins (bare tool name = their key). Managed
    outside this tab, so excluded from listing and protected from toggling."""
    return {n["name"] for n in native_catalog()}


def _is_deep(definition) -> bool:
    return (definition.manifest or {}).get("type") == "deep agent"


def _declared_mcp_rows(definition, disabled: Set[str]) -> Dict[str, AgentToolRow]:
    """The agent's declared MCP tools (default-ON), keyed by cache key. Native
    spec refs are intentionally skipped — natives are not managed here."""
    rows: Dict[str, AgentToolRow] = {}
    spec = getattr(definition, "spec", None)
    if spec is None:
        return rows
    mcp_map = get_cached_tool_manifests_map()
    for tool in spec.tools:
        if getattr(tool, "native", None):
            continue  # native builtins are controlled in Personalization / always-on
        key = build_tool_cache_key(tool.server_id or "", tool.tool_name or "")
        manifest = mcp_map.get(key)
        rows[key] = AgentToolRow(
            key=key, name=(tool.tool_name or key),
            description=(getattr(manifest, "description", "") or "") if manifest else "",
            source="mcp", declared=True, disabled=key in disabled,
        )
    return rows


def list_agent_tools(user_id: str, agent_slug: str) -> Optional[List[AgentToolRow]]:
    """MCP tool rows for (user, agent), or ``None`` when the agent is unknown.

    Reports the **baseline** only: declared MCP tools ON, every other gateway
    tool OFF. Native builtins are never included.

    This service no longer knows anything about the user's choices — those live
    in ``chat_db`` and the bridge overlays them onto these rows. Keeping a second
    opinion here would just be a copy to disagree with.
    """
    definition = _resolve_for_user(agent_slug, user_id)
    if definition is None:
        return None
    if not _is_deep(definition):
        return []

    rows = _declared_mcp_rows(definition, set())

    # Available: every gateway MCP tool the agent did not declare, OFF by
    # default. Relies on the manifest cache being warm (the tools endpoint warms
    # it) — a cold cache simply yields no available rows.
    for key, manifest in get_cached_tool_manifests_map().items():
        if key in rows:
            continue
        rows[key] = AgentToolRow(
            key=key, name=(getattr(manifest, "tool_name", "") or key),
            description=(getattr(manifest, "description", "") or ""),
            source="mcp", declared=False, disabled=True,
        )

    # Declared first, then available alphabetically — stable for the UI.
    return sorted(rows.values(), key=lambda r: (not r.declared, r.name.lower()))


