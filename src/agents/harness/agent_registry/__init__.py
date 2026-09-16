"""User-authored agent definitions, stored in ``agent_runtime``.

The counterpart to :mod:`harness.skill_registry` for the other thing a user
authors. A custom agent's spec and its prompt files are runtime content — the
agents service reads them on every run — so they live in the database that
service owns, and ``/reference/`` is a virtual route over the same rows.

Platform agent definitions stay on the volume: they ship in the image, are
identical for every user and are never written at runtime.
"""
from harness.agent_registry.store import MANIFEST_FILENAME, AgentDefinitionStore

__all__ = [
    "MANIFEST_FILENAME",
    "AgentDefinitionStore",
]
