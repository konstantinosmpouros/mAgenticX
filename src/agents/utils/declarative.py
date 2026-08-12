"""Helpers for declarative (YAML-defined) agents.

Kept out of ``runtime/abstractions/`` so the *runtime* package holds only the
agent machinery itself (the spec model, the generic agent, the seeder, the
authoring CRUD) while these shared helpers live with the service's other
utilities, per the repo's layer convention:

* :func:`manifest_from_spec` lets the registry discoverer build a manifest
  straight from a spec, without importing the agent runtime at all, and
* :func:`read_prompt` keeps prompt resolution reusable and unit-testable in
  isolation.

**The dependency on ``AgentSpec`` is deliberately type-only.** ``utils/__init__``
eagerly imports modules that reach into ``runtime`` (``checkpointer``,
``skills``), and ``runtime.abstractions``'s own package init imports
``yaml_agent``, which imports this module — so a real import of
``runtime.abstractions.agent_spec`` here would make the resulting cycle
order-dependent: whichever side is imported first wins, and the other raises
``ImportError`` on a half-initialised module. Under ``TYPE_CHECKING`` the edge
exists for type checkers only, and there is no cycle to trip over at runtime.
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only, see the module docstring
    from runtime.abstractions.agent_spec import AgentSpec


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


def manifest_from_spec(spec: "AgentSpec") -> dict[str, Any]:
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
