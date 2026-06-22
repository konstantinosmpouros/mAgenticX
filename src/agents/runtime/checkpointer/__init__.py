"""Accessor for the process-wide durable LangGraph checkpointer.

``main._lifespan`` builds one ``AsyncPostgresSaver`` and installs it via
``set_checkpointer``; the agent runtime reads it via ``get_checkpointer``.
"""
from runtime.checkpointer.store import (
    get_checkpointer,
    has_checkpointer_initialized,
    set_checkpointer,
)

__all__ = [
    "get_checkpointer",
    "has_checkpointer_initialized",
    "set_checkpointer",
]
