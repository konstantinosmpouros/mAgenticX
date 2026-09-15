"""Delete one durable memory for this (user, agent).

One folder per tool: ``tool.py`` holds the implementation, this barrel fixes
the public surface so ``harness.tools.forget`` stays the import path no matter
how the folder is later split.
"""
from harness.tools.forget.tool import (
    build_forget_tool,
)

__all__ = [
    "build_forget_tool",
]
