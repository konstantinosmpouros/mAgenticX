"""The durable LangGraph checkpointer package.

``bootstrap.init_durable_checkpointer`` (called from ``main._lifespan``) opens
the psycopg pool, ensures the ``agent_runtime`` database exists, and installs
one shared ``AsyncPostgresSaver`` via ``set_checkpointer``; the agent runtime
reads it back via ``get_checkpointer``. ``fork`` seeds new branch threads from
a parent checkpoint on edit/retry.
"""
from runtime.checkpointer.bootstrap import init_durable_checkpointer
from runtime.checkpointer.store import (
    get_checkpointer,
    has_checkpointer_initialized,
    set_checkpointer,
)

__all__ = [
    "get_checkpointer",
    "has_checkpointer_initialized",
    "init_durable_checkpointer",
    "set_checkpointer",
]
