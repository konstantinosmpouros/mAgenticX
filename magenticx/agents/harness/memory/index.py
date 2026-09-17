"""The canonical format of one ``AGENTS.md`` index row.

Lives with memory rather than with the filesystem because there is no longer a
filesystem behind it: the index is derived from ``agent_memories`` rows on read.
Keeping the format in one place is load-bearing — the row is matched by name to
be replaced or removed, so a second implementation of this string would silently
fail to match the first.
"""
from __future__ import annotations

import re

MEMORIES_HEADER = "## Memories"


def index_line(name: str, summary: str) -> str:
    """The one canonical index row: ``- **<name>** — <summary>``.

    The bold name at a fixed leading position is a stable, unique anchor, so a
    single row can be pinpointed by name.
    """
    return f"- **{name}** — {summary}"


def index_line_pattern(name: str) -> "re.Pattern[str]":
    """Regex matching exactly the index row for ``name`` (anchored on its bold name)."""
    return re.compile(rf"^- \*\*{re.escape(name)}\*\* ")


__all__ = ["MEMORIES_HEADER", "index_line", "index_line_pattern"]
