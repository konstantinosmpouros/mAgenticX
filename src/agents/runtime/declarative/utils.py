"""Helpers for declarative (YAML) agents.

Extracted from ``yaml_agent`` so:

* the discoverer can build a registry manifest straight from a spec
  (:func:`manifest_from_spec`) without importing the agent runtime, and
* prompt loading (:func:`read_prompt`) is reusable and unit-testable in
  isolation.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from runtime.declarative.agent_spec import AgentSpec


def read_prompt(value: str, source_dir: Path) -> str:
    """Resolve a prompt field to text.

    A value that looks like a path (``./x.md``, ``../x``, or ``*.md``) is read
    from a file **confined to the agent directory** (traversal-guarded);
    anything else is treated as an inline prompt string.
    """
    candidate = value.strip()
    looks_like_path = (
        candidate.startswith("./")
        or candidate.startswith("../")
        or candidate.endswith(".md")
    )
    if not looks_like_path:
        return value

    root = source_dir.resolve()
    target = (root / candidate).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"prompt path {value!r} escapes the agent directory {root}")
    return target.read_text(encoding="utf-8")


def manifest_from_spec(spec: AgentSpec) -> dict[str, Any]:
    """The registry manifest for a YAML agent (mirrors ``BaseAgent.manifest``).

    ``type`` is normalised from the spec's ``deep_agent`` to the runtime literal
    ``"deep agent"`` the bridge persists and the UI keys off.
    """
    return {
        "id": spec.id,
        "slug": spec.slug,
        "name": spec.name,
        "version": spec.version,
        "type": "deep agent",
        "description": spec.description or "",
        "icon": spec.icon or "",
    }


__all__ = ["read_prompt", "manifest_from_spec"]
