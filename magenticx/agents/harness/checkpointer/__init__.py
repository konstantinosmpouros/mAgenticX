"""The durable LangGraph checkpointer package.

``bootstrap.init_durable_checkpointer`` (called from ``main._lifespan``) opens
the psycopg pool, ensures the ``agent_runtime`` database exists, and installs
one shared ``AsyncPostgresSaver`` via ``set_checkpointer``; the agent runtime
reads it back via ``get_checkpointer``. ``fork`` seeds new branch threads from
a parent checkpoint on edit/retry; ``compaction`` compacts a branch on request
and undoes it (plan 34).
"""
from harness.checkpointer.bootstrap import init_durable_checkpointer
from harness.checkpointer.compaction import (
    CompactionConflict,
    CompactionFailed,
    CompactionResult,
    compact_thread,
    undo_compaction,
)
from harness.checkpointer.store import (
    get_checkpointer,
    has_checkpointer_initialized,
    set_checkpointer,
)

__all__ = [
    "CompactionConflict",
    "CompactionFailed",
    "CompactionResult",
    "compact_thread",
    "get_checkpointer",
    "has_checkpointer_initialized",
    "init_durable_checkpointer",
    "set_checkpointer",
    "undo_compaction",
]
