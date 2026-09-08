"""Agent memory — stored in ``agent_runtime``, surfaced as the ``/memories/`` mount.

``store`` implements LangGraph's ``BaseStore`` over the ``agent_memories`` table,
so deepagents' ``StoreBackend`` can present it to the agent as a filesystem with
no filesystem behind it. ``pool`` is the process-wide handle the lifespan wires.

There is no import/adoption pass: the table is the only home memory has ever had
in a released build. Both environments were checked before the cutover and held
zero entry files, so there was nothing to migrate — the seeded ``memory/``
folders on the volume are empty templates and simply stop being read.
"""
from harness.memory.pool import get_memory_pool, has_memory_pool, set_memory_pool
from harness.memory.store import (
    INDEX_KEY,
    AgentMemoryStore,
    build_index,
    entry_key,
    entry_name,
    parse_entry,
    render_entry,
)

__all__ = [
    "AgentMemoryStore",
    "INDEX_KEY",
    "build_index",
    "entry_key",
    "entry_name",
    "get_memory_pool",
    "has_memory_pool",
    "parse_entry",
    "render_entry",
    "set_memory_pool",
]
