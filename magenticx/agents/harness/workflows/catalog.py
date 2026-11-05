"""The node catalogue as the builder reads it: ``GET /workflows/catalog``.

One entry per kind — label, group, description, branches and the JSON Schema of
its config (the builder renders its form from it) — derived from the classes,
so the catalogue can never disagree with what the validator accepts.
"""
from __future__ import annotations

from typing import Any

from harness.workflows.nodes import NODE_KINDS


def node_catalog() -> list[dict[str, Any]]:
    """Every node kind, in catalogue order."""
    return [cls.catalog_entry() for cls in NODE_KINDS.values()]


__all__ = ["node_catalog"]
