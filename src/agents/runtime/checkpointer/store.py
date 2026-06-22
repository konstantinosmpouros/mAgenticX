"""Process-level handle to the durable LangGraph checkpointer.

The agents service runs a single shared ``AsyncPostgresSaver`` over a
long-lived ``psycopg_pool.AsyncConnectionPool`` (opened in the FastAPI
lifespan). Every ``/agents/{slug}/stream`` and ``/agents/{slug}/resume``
request builds a fresh agent instance, but they all compile against this one
saver; the thread is selected per-request via
``run_config.configurable.thread_id`` — the standard AsyncPostgresSaver model.

Threads persist indefinitely (no TTL); a conversation's threads are reaped
only when the conversation is deleted. This module is just the accessor that
``main._lifespan`` populates and the agent runtime reads — kept separate so
the agent classes never import ``main`` (avoids the import cycle).

The saver type is intentionally left as ``Any`` here so importing this module
does not require ``langgraph-checkpoint-postgres`` / ``psycopg`` to be present
(the heavy deps are imported lazily inside the lifespan).
"""

from __future__ import annotations

from typing import Any, Optional

_checkpointer: Optional[Any] = None


def set_checkpointer(checkpointer: Any) -> None:
    """Install the process-wide saver. Called once from the lifespan."""
    global _checkpointer
    _checkpointer = checkpointer


def get_checkpointer() -> Any:
    """Return the shared saver. Raises if the lifespan hasn't wired it yet."""
    if _checkpointer is None:
        raise RuntimeError(
            "Durable checkpointer is not initialized. The FastAPI lifespan must "
            "call set_checkpointer() before any agent run."
        )
    return _checkpointer


def has_checkpointer_initialized() -> bool:
    """Cheap probe: is the shared saver wired? (Not a per-thread existence check.)"""
    return _checkpointer is not None
