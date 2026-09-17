"""Helpers for declarative (YAML-defined) agents.

Kept out of ``harness/abstractions/`` so the *runtime* package holds only the
agent machinery itself (the spec model, the generic agent, the seeder, the
authoring CRUD) while these shared helpers live with the service's other
utilities, per the repo's layer convention:

* :func:`manifest_from_spec` lets the registry discoverer build a manifest
  straight from a spec, without importing the agent runtime at all, and
* :func:`read_prompt` keeps prompt resolution reusable and unit-testable in
  isolation.

**The dependency on ``AgentSpec`` is deliberately type-only.** ``utils/__init__``
eagerly imports modules that reach into ``runtime`` (``checkpointer``,
``skills``), and ``harness.abstractions``'s own package init imports
``yaml_agent``, which imports this module — so a real import of
``harness.abstractions.agent_spec`` here would make the resulting cycle
order-dependent: whichever side is imported first wins, and the other raises
``ImportError`` on a half-initialised module. Under ``TYPE_CHECKING`` the edge
exists for type checkers only, and there is no cycle to trip over at runtime.
"""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only, see the module docstring
    from harness.abstractions.agent_spec import AgentSpec


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


def resolve_prompt(value: str, files: Mapping[str, str]) -> str:
    """The store-backed twin of :func:`read_prompt`.

    A user-authored agent has no directory, so a path-shaped prompt reference is
    looked up in the definition's own file map instead of on disk. Same two
    branches as ``read_prompt`` — a value that does not look like a path is an
    inline prompt — so a spec means the same thing whichever kind of agent
    carries it.

    Confinement is structural rather than checked: the map only ever holds this
    agent's own files, so there is no parent directory to escape into and no
    traversal guard to get wrong. A reference to a file that is not there raises,
    because an agent whose system prompt silently resolved to an empty string is
    far worse than one that fails to build — and ``validate_write`` already
    refuses a spec whose prompt is not among the uploaded files.
    """
    candidate = value.strip()
    looks_like_path = (
        candidate.startswith("./")
        or candidate.startswith("../")
        or candidate.endswith(".md")
    )
    if not looks_like_path:
        return value

    key = candidate.replace("\\", "/").lstrip("./").lstrip("/")
    if key not in files:
        raise ValueError(
            f"prompt path {value!r} is not among this agent's definition files"
        )
    return files[key]


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


__all__ = ["manifest_from_spec", "read_prompt"]
