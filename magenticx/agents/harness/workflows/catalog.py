"""What the builder reads: the node catalogue and the tools a Tool step may call.

``GET /workflows/catalog``: one entry per kind — label, group, description,
branches and the JSON Schema of its config (the builder renders its form from
it) — derived from the classes, so the catalogue can never disagree with what
the validator accepts.

``GET /workflows/tools``: every tool a ``tool`` step may call, each with its
input JSON Schema, so the builder can offer a picker and the tool's own
arguments (required ones shown, optional ones added on demand).
"""
from __future__ import annotations

from typing import Any

from harness.tools.registry import NATIVE_TOOLS, NativeToolContext
from harness.workflows.nodes import NODE_KINDS
from harness.workflows.nodes.tool import WORKFLOW_NATIVE_TOOLS
from utils.mcp_tools import build_cache_key_from_tool_name, mcp_tool_definitions

#: A context only for reading a native tool's schema; the tool is never called.
_SCHEMA_CONTEXT = NativeToolContext(
    user_id="",
    agent_slug="workflow:catalog",
    conversation_id=None,
    use_memory=False,
    search_past_convs=True,
    interactive=False,
)


def node_catalog() -> list[dict[str, Any]]:
    """Every node kind, in catalogue order."""
    return [cls.catalog_entry() for cls in NODE_KINDS.values()]


def _native_tools() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for name in sorted(WORKFLOW_NATIVE_TOOLS):
        defn = NATIVE_TOOLS.get(name)
        tool = defn.builder(_SCHEMA_CONTEXT) if defn is not None else None
        if tool is None:
            continue
        entries.append({
            "source": "native",
            "name": name,
            "server": None,
            "description": defn.description or getattr(tool, "description", "") or "",
            "inputSchema": tool.tool_call_schema.model_json_schema(),
        })
    return entries


async def tool_catalog() -> dict[str, Any]:
    """The tools a ``tool`` step may call: the allowed native ones, then the
    gateway's. ``mcpAvailable`` is false when the gateway could not be read."""
    definitions = await mcp_tool_definitions()
    mcp: list[dict[str, Any]] = []
    for tool in definitions or []:
        server, _, _ = build_cache_key_from_tool_name(tool.name).rpartition("/")
        schema = tool.inputSchema if isinstance(tool.inputSchema, dict) else {}
        mcp.append({
            "source": "mcp",
            "name": tool.name,
            "server": server or None,
            "description": (tool.description or "").strip(),
            "inputSchema": schema or {"type": "object", "properties": {}},
        })
    mcp.sort(key=lambda entry: ((entry["server"] or "~").lower(), entry["name"].lower()))
    return {"mcpAvailable": definitions is not None, "tools": [*_native_tools(), *mcp]}


__all__ = ["node_catalog", "tool_catalog"]
