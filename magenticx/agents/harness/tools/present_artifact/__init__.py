"""Hand a finished document to the user.

One folder per tool: ``tool.py`` holds the implementation, this barrel fixes
the public surface so ``harness.tools.present_artifact`` stays the import path no matter
how the folder is later split.
"""
from harness.tools.present_artifact.tool import (
    build_present_artifact_tool,
)

__all__ = [
    "build_present_artifact_tool",
]
