"""Read / list / delete operations over a (user, agent)'s persistent memory.

The `remember` tool (runtime/tools/remember.py) is the *write* path; this module
owns the *shape* — the single source of truth for the `AGENTS.md` index row
format (shared with the write path) plus the list / read / delete the Memory
inspector endpoints use. A delete removes **both** the `entries/<name>.yml` file
and its index row, matched by the same pattern the write path uses, so the two
can never drift. Pure filesystem layer — no deepagents/tool dependency.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml

from core.logging import get_logger
from runtime.filesystem.provisioner import (
    _safe_segment,
    memory_entries_root,
    memory_index_path,
)

logger = get_logger(__name__)

MEMORIES_HEADER = "## Memories"


def index_line(name: str, summary: str) -> str:
    """The one canonical AGENTS.md index row: ``- **<name>** — <summary>``.

    The bold name at a fixed leading position is a stable, unique anchor so a
    single row can be pinpointed and removed by name.
    """
    return f"- **{name}** — {summary}"


def index_line_pattern(name: str) -> "re.Pattern[str]":
    """Regex matching exactly the index row for ``name`` (anchored on its bold name)."""
    return re.compile(rf"^- \*\*{re.escape(name)}\*\* ")


def _atomic_write(path: Path, text: str) -> None:
    """Write via a sibling temp file + rename so a reader never sees a partial file."""
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _read_entry(path: Path) -> dict[str, Any] | None:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (yaml.YAMLError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _safe_slug(name: str) -> str | None:
    """Path-safe slug, or None if ``name`` is illegal (traversal etc.)."""
    try:
        return _safe_segment(name)
    except ValueError:
        return None


def list_memories(user_id: str, agent_slug: str) -> list[dict[str, Any]]:
    """Metadata for every saved memory, sorted by name. Light — no `content`."""
    entries_dir = memory_entries_root(user_id, agent_slug)
    if not entries_dir.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for path in sorted(entries_dir.glob("*.yml"), key=lambda p: p.stem):
        data = _read_entry(path)
        if data is None:
            continue
        out.append({
            "name": data.get("name") or path.stem,
            "summary": data.get("summary") or "",
            "created_at": data.get("created_at"),
            "updated_at": data.get("updated_at"),
            "source_conversation_id": data.get("source_conversation_id"),
        })
    return out


def read_memory(user_id: str, agent_slug: str, name: str) -> dict[str, Any] | None:
    """One memory's full record (incl. `content`), or None if absent/illegal."""
    slug = _safe_slug(name)
    if slug is None:
        return None
    path = memory_entries_root(user_id, agent_slug) / f"{slug}.yml"
    if not path.is_file():
        return None
    data = _read_entry(path)
    if data is None:
        return None
    return {
        "name": data.get("name") or slug,
        "summary": data.get("summary") or "",
        "content": data.get("content") or "",
        "created_at": data.get("created_at"),
        "updated_at": data.get("updated_at"),
        "source_conversation_id": data.get("source_conversation_id"),
    }


def delete_memory(user_id: str, agent_slug: str, name: str) -> bool:
    """Delete a memory: remove its ``entries/<name>.yml`` AND its AGENTS.md row.

    Returns True if the entry file existed and was removed; idempotent (a missing
    entry returns False without error). The index row is dropped regardless, so a
    stale row with no file is also cleaned up.
    """
    slug = _safe_slug(name)
    if slug is None:
        return False
    entry_path = memory_entries_root(user_id, agent_slug) / f"{slug}.yml"
    existed = entry_path.is_file()
    if existed:
        entry_path.unlink()

    index_path = memory_index_path(user_id, agent_slug)
    if index_path.is_file():
        pattern = index_line_pattern(slug)
        lines = index_path.read_text(encoding="utf-8").splitlines()
        kept = [ln for ln in lines if not pattern.match(ln)]
        if len(kept) != len(lines):
            _atomic_write(index_path, "\n".join(kept) + "\n")

    if existed:
        logger.info(
            "memory_deleted",
            "Deleted an agent memory entry",
            agent_slug=agent_slug,
            memory_name=slug,
        )
    return existed
