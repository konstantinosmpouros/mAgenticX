"""Per-(user, agent) tool overrides — the tools a user has turned OFF or ON for an agent.

An agent declares a baseline tool set (``agent.yaml`` ``tools:`` for YAML agents),
and the always-on native builtins are added on top. On top of that baseline the
user keeps **two override sets per agent** (the Agents tab):

* ``disabledTools`` — keys the user turned OFF. Meaningful for tools that are ON
  by default: the native builtins and the agent's declared tools.
* ``enabledTools`` — keys the user turned ON. Meaningful for tools that are OFF
  by default: MCP tools from the gateway catalog the agent did **not** declare.

Effective set at build time (see ``DeepAgent._apply_tool_disables`` +
``YamlDeepAgent`` seeding ``config_tool_names``)::

    effective = (declared ∪ user_enabled) − user_disabled

Stored at ``<agent_root>/tool_prefs.json``::

    {"version": 2, "disabledTools": ["rag/sql_query"], "enabledTools": ["tavily/tavily-search"]}

Keys are the **canonical tool-cache-key** form (``utils.get_tool_cache_key`` /
``utils.build_tool_cache_key``): ``<server>/<tool>`` for MCP, the bare name for
server-less/native tools — so both sets match live tools with one key function.

Back-compat: a ``version: 1`` file (``disabledTools`` only) reads cleanly — the
missing ``enabledTools`` is treated as empty.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Set, Tuple

from core.logging import get_logger
from runtime.filesystem.provisioner import agent_root

logger = get_logger(__name__)

_VERSION = 2
_FILENAME = "tool_prefs.json"


def _tool_prefs_path(user_id: str, agent_slug: str) -> Path:
    return agent_root(user_id, agent_slug) / _FILENAME


def _coerce_key_set(value: object) -> Set[str]:
    """A clean set of non-empty string keys from an arbitrary JSON value."""
    if not isinstance(value, list):
        return set()
    return {str(k) for k in value if isinstance(k, str) and k}


def read_tool_prefs(user_id: str, agent_slug: str) -> Tuple[Set[str], Set[str]]:
    """Return ``(disabled, enabled)`` key sets for this (user, agent).

    Fail-open: any missing/corrupt file yields two empty sets. Overrides are the
    only thing lost, and the safe default is "the agent's declared baseline" —
    never silently disable a declared tool nor silently enable a catalog one.
    """
    path = _tool_prefs_path(user_id, agent_slug)
    try:
        if not path.is_file():
            return set(), set()
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return set(), set()
        return _coerce_key_set(data.get("disabledTools", [])), _coerce_key_set(data.get("enabledTools", []))
    except (OSError, ValueError):
        logger.warning(
            "tool_prefs_read_failed",
            "Failed to read tool prefs; treating as no overrides",
            exc_info=True,
            agent_slug=agent_slug,
        )
        return set(), set()


def read_disabled_tools(user_id: str, agent_slug: str) -> Set[str]:
    """The keys the user disabled for this (user, agent). Used by the runtime's
    ``_apply_tool_disables`` to subtract from the built tool set."""
    return read_tool_prefs(user_id, agent_slug)[0]


def read_enabled_tools(user_id: str, agent_slug: str) -> Set[str]:
    """The catalog MCP keys the user enabled for this (user, agent) beyond what
    the agent declares. Unioned into ``config_tool_names`` at build time so the
    live-manifest filter keeps them."""
    return read_tool_prefs(user_id, agent_slug)[1]


def write_tool_prefs(user_id: str, agent_slug: str, disabled: Set[str], enabled: Set[str]) -> None:
    """Persist both override sets atomically, creating the agent dir as needed."""
    path = _tool_prefs_path(user_id, agent_slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(
            {"version": _VERSION, "disabledTools": sorted(disabled), "enabledTools": sorted(enabled)},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    os.replace(tmp, path)
    logger.info(
        "tool_prefs_updated",
        "Updated per-agent tool overrides",
        agent_slug=agent_slug,
        disabled_count=len(disabled),
        enabled_count=len(enabled),
    )


__all__ = ["read_tool_prefs", "read_disabled_tools", "read_enabled_tools", "write_tool_prefs"]
