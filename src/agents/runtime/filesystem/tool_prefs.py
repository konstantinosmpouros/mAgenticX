"""Per-(user, agent) tool enablement — the tools a user has DISABLED for an agent.

An agent declares its tool set (``agent.yaml`` ``tools:`` for YAML agents, or the
request for legacy Python agents). The user may disable a subset **per agent**
(the Agents tab). That disabled set is persisted here, keyed by (user, agent),
and subtracted from the agent's tools at build time — see
``DeepAgent._apply_tool_disables``:

    enabled = declared_tools − disabled(user, agent)

Stored at ``<agent_root>/tool_prefs.json``::

    {"version": 1, "disabledTools": ["rag/sql_query", "present_artifact"]}

Keys are the **canonical tool-cache-key** form (``utils.get_tool_cache_key`` /
``utils.build_tool_cache_key``): ``<server>/<tool>`` for MCP tools, the bare name
for server-less/native tools — so the disabled set matches live tools directly
with a single key function and needs no MCP-vs-native branching.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Set

from observability import get_logger
from runtime.filesystem.provisioner import agent_root

logger = get_logger(__name__)

_VERSION = 1
_FILENAME = "tool_prefs.json"


def _tool_prefs_path(user_id: str, agent_slug: str) -> Path:
    return agent_root(user_id, agent_slug) / _FILENAME


def read_disabled_tools(user_id: str, agent_slug: str) -> Set[str]:
    """The canonical tool keys the user disabled for this (user, agent).

    Fail-open: any missing/corrupt file yields an empty set. Disabling is a
    restriction, so a broken prefs file must never silently *disable* tools —
    the safe default is "everything the agent declares stays enabled".
    """
    path = _tool_prefs_path(user_id, agent_slug)
    try:
        if not path.is_file():
            return set()
        data = json.loads(path.read_text(encoding="utf-8"))
        disabled = data.get("disabledTools", []) if isinstance(data, dict) else []
        return {str(k) for k in disabled if isinstance(k, str) and k}
    except (OSError, ValueError):
        logger.warning(
            "tool_prefs_read_failed",
            "Failed to read tool prefs; treating as no disables",
            exc_info=True,
            agent_slug=agent_slug,
        )
        return set()


def set_tool_disabled(user_id: str, agent_slug: str, tool_key: str, disabled: bool) -> Set[str]:
    """Add/remove ``tool_key`` from the disabled set; return the updated set.

    Creates the agent directory + file as needed and writes atomically.
    """
    key = tool_key.strip()
    if not key:
        raise ValueError("tool_key must be a non-empty string")

    current = read_disabled_tools(user_id, agent_slug)
    if disabled:
        current.add(key)
    else:
        current.discard(key)

    path = _tool_prefs_path(user_id, agent_slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"version": _VERSION, "disabledTools": sorted(current)}, ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp, path)
    logger.info(
        "tool_prefs_updated",
        "Updated per-agent tool disable state",
        agent_slug=agent_slug,
        tool_key=key,
        disabled=disabled,
        disabled_count=len(current),
    )
    return current


__all__ = ["read_disabled_tools", "set_tool_disabled"]
