"""Process-level handle to the connection pool backing agent memory.

Memory lives in ``agent_runtime``, the database this service already owns and
creates (``harness/checkpointer/bootstrap.py``). Rather than open a second pool
for one table, the lifespan installs the checkpointer's pool here and the memory
store borrows it — same database, same credentials, same keepalive and
health-check settings.

Mirrors :mod:`harness.checkpointer.store` deliberately, including leaving the
pool type as ``Any``: importing this module must not require ``psycopg`` to be
present, because the mount wiring in ``harness/filesystem/workspace.py`` imports
it at module load.
"""
from __future__ import annotations

from typing import Any, Optional

_pool: Optional[Any] = None


def set_memory_pool(pool: Any) -> None:
    """Install the process-wide pool. Called once from the lifespan."""
    global _pool
    _pool = pool


def get_memory_pool() -> Any:
    """Return the shared pool. Raises if the lifespan has not wired it yet."""
    if _pool is None:
        raise RuntimeError(
            "Agent memory pool is not initialized. The FastAPI lifespan must "
            "call set_memory_pool() before any agent run or memory read."
        )
    return _pool


def has_memory_pool() -> bool:
    """Cheap probe — is the pool wired? Used to fail a mount build early."""
    return _pool is not None


__all__ = ["set_memory_pool", "get_memory_pool", "has_memory_pool"]
