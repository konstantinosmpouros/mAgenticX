"""Look at an image from the conversation filesystem.

One folder per tool: ``tool.py`` holds the implementation, this barrel fixes
the public surface so ``harness.tools.view_image`` stays the import path no matter
how the folder is later split.
"""
from harness.tools.view_image.tool import (
    MIME_BY_SUFFIX,
    SUPPORTED_MIMES,
    build_view_image_tool,
    clamp_region,
)

__all__ = [
    "MIME_BY_SUFFIX",
    "SUPPORTED_MIMES",
    "build_view_image_tool",
    "clamp_region",
]
