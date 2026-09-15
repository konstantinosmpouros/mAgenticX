"""Search the user's earlier conversations.

One folder per tool: ``tool.py`` holds the implementation, this barrel fixes
the public surface so ``harness.tools.memory_search`` stays the import path no matter
how the folder is later split.
"""
from harness.tools.memory_search.tool import (
    build_memory_search_tool,
)

__all__ = [
    "build_memory_search_tool",
]
