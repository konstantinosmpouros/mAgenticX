"""Files that travel with an exec call — the box's only view of the conversation.

A conversation's files live in ``agent_runtime`` rows (plan 36), not on a disk
the runner could share, so the agents service sends the files a command needs
and the runner sends back what the command wrote. A file path is a *name in the
call's own temp dir*, never a host path: it must start with ``input/`` or
``output/`` and the rest must be a normalised relative path (no ``..``, no
absolute path, no backslash, no control characters, depth ≤ 4, ≤ 200 chars).
The same rule filters what comes back, so a name the box invents that the
agents service could not store is dropped rather than returned.
"""
from __future__ import annotations

import unicodedata
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_PATH_CHARS = 200
MAX_DEPTH = 4
MAX_SEGMENT_BYTES = 255
MAX_FILES = 100

Area = Literal["input", "output"]


def split_file_path(path: str) -> tuple[Area, str] | None:
    """``"input/a/b.csv"`` → ``("input", "a/b.csv")``; None when the path breaks a rule."""
    if not isinstance(path, str) or len(path) > MAX_PATH_CHARS:
        return None
    area, sep, rel = path.partition("/")
    if area not in ("input", "output") or not sep:
        return None
    return (area, rel) if is_safe_relative_path(rel) else None  # type: ignore[return-value]


def is_safe_relative_path(rel: str) -> bool:
    """A normalised relative POSIX path that can only name something below its base."""
    if not rel or rel.startswith("/") or "\\" in rel:
        return False
    parts = rel.split("/")
    if len(parts) > MAX_DEPTH:
        return False
    for part in parts:
        if part in ("", ".", ".."):
            return False
        if len(part.encode("utf-8", errors="replace")) > MAX_SEGMENT_BYTES:
            return False
        if any(unicodedata.category(ch) == "Cc" for ch in part):
            return False
    return True


class FileIn(BaseModel):
    """One file to place in the box before the command runs."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(..., min_length=1, max_length=MAX_PATH_CHARS + len("output/"))
    content_b64: str

    @field_validator("path")
    @classmethod
    def _safe_path(cls, value: str) -> str:
        if split_file_path(value) is None:
            raise ValueError("path must be input/<rel> or output/<rel> with a normalised relative <rel>")
        return value


class FileOut(BaseModel):
    """One file the command created or changed under ``output/``."""

    model_config = ConfigDict(extra="forbid")

    path: str
    content_b64: str
    size: int = Field(..., ge=0)
