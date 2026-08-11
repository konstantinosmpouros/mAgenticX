"""Per-run personalization — personality preset + custom instructions.

Packaged form of the former ``runtime/personalization.py``; the implementation
lives in ``personalization.py`` inside this package and is re-exported here so
``from runtime.personalization import ...`` keeps working unchanged.
"""
from runtime.personalization.personalization import (
    Personalization,
    build_personalization_prompt,
    parse_personalization,
)

__all__ = [
    "Personalization",
    "parse_personalization",
    "build_personalization_prompt",
]
