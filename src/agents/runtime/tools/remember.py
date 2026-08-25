"""Agent tool: save a durable memory for this (user, agent) pair.

Bound **per run** (closes over the current run's ``user_id`` + ``agent_slug`` +
``conversation_id``, which ``BaseAgent`` reads from the request config into
``self.context``), so it can never write into another (user, agent)'s memory.

Writes directly to the agent's per-(user, agent) filesystem volume — the same
tree mounted at ``/memories/`` — so each memory is one ``entries/<name>.yml``
detail file plus a one-line summary in the ``AGENTS.md`` index. The index is
what the model always sees (injected as always-on context at the next
conversation's build); it reads the yml on demand. The tool keeps the two in
sync and is idempotent by name — re-saving the same name updates in place.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path

import yaml
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from core.settings import settings
from core.logging import get_logger
from runtime.filesystem import (
    AGENTS_MD_TEMPLATE,
    MEMORIES_HEADER,
    ensure_user_agent_filesystem,
    index_line,
    index_line_pattern,
    memory_entries_root,
    memory_index_path,
)

logger = get_logger(__name__)

_MAX_SUMMARY = 200
_MAX_CONTENT = 8000


class _RememberArgs(BaseModel):
    name: str = Field(
        description="Short identifier for this memory, e.g. 'user-timezone' or "
        "'project-magenticx'. Reused as the entry's filename — re-using an "
        "existing name updates that memory in place."
    )
    summary: str = Field(
        description="One concise line describing the memory. This is what you "
        "always see in your memory index, so make it self-contained."
    )
    content: str = Field(
        description="The full detail to store — everything worth recalling later. "
        "Saved to the entry file you can read on demand."
    )


def _slugify(name: str) -> str:
    """Normalise a memory name into a filesystem-safe slug (``[a-z0-9-]``).

    Collapsing to this charset also defeats path traversal — the result can
    contain no slashes or dots, so it can never escape ``entries/``.
    """
    return re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")


def _atomic_write(path: Path, text: str) -> None:
    """Write via a sibling temp file + rename so a concurrent reader (or the
    next run loading the index) never observes a half-written file."""
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _upsert_index_line(index_text: str, slug: str, summary: str) -> str:
    """Return ``index_text`` with the row for ``slug`` inserted or replaced under
    the Memories header. Idempotent by slug (no duplicates)."""
    pattern = index_line_pattern(slug)
    lines = [ln for ln in index_text.splitlines() if not pattern.match(ln)]
    for i, ln in enumerate(lines):
        if ln.strip().lower() == MEMORIES_HEADER.lower():
            lines.insert(i + 1, index_line(slug, summary))
            break
    else:
        lines.extend(["", MEMORIES_HEADER, index_line(slug, summary)])
    return "\n".join(lines) + "\n"


def build_remember_tool(
    *, user_id: str, agent_slug: str, conversation_id: str | None
) -> StructuredTool:
    """Return a ``remember`` tool bound to this run's (user, agent)."""

    def _remember(name: str, summary: str, content: str) -> str:
        slug = _slugify(name)
        if not slug:
            return "Could not save: 'name' must contain letters or digits."
        summary = summary.strip()[:_MAX_SUMMARY]
        content = content.strip()[:_MAX_CONTENT]
        if not summary or not content:
            return "Could not save: both 'summary' and 'content' are required."

        # Provision the per-(user, agent) memory tree, then write the detail
        # file and sync the index. Bound to this run's identity — no traversal.
        ensure_user_agent_filesystem(user_id=user_id, agent_slug=agent_slug)
        entries_dir = memory_entries_root(user_id, agent_slug)
        index_path = memory_index_path(user_id, agent_slug)
        entry_path = entries_dir / f"{slug}.yml"

        # Hard cap per (user, agent): updates to an existing entry always go
        # through; only brand-new entries are refused once the limit is hit.
        if not entry_path.exists():
            cap = settings.filesystem.memory_max_entries
            current = len(list(entries_dir.glob("*.yml")))
            if current >= cap:
                return (
                    f"Memory is full ({current}/{cap}). Update an existing memory "
                    "instead, or ask the user to remove some in their memory panel."
                )

        now = datetime.now(timezone.utc).isoformat()
        # Preserve the original created_at when updating an existing memory.
        created_at = now
        if entry_path.exists():
            try:
                prior = yaml.safe_load(entry_path.read_text(encoding="utf-8")) or {}
                created_at = prior.get("created_at") or now
            except (yaml.YAMLError, OSError):
                created_at = now

        record = {
            "name": slug,
            "summary": summary,
            "content": content,
            "created_at": created_at,
            "updated_at": now,
            "source_conversation_id": conversation_id,
        }
        try:
            _atomic_write(
                entry_path,
                yaml.safe_dump(record, sort_keys=False, allow_unicode=True),
            )
            index_text = (
                index_path.read_text(encoding="utf-8")
                if index_path.exists()
                else AGENTS_MD_TEMPLATE
            )
            _atomic_write(index_path, _upsert_index_line(index_text, slug, summary))
        except OSError as exc:
            logger.warning(
                "remember_tool_write_failed",
                "Failed to persist a memory entry",
                agent_slug=agent_slug,
                failure_reason=type(exc).__name__,
            )
            return "Could not save the memory right now."

        logger.info(
            "memory_saved",
            "Saved an agent memory entry",
            agent_slug=agent_slug,
            memory_name=slug,
        )
        return f"Saved memory '{slug}'. It will be available in your future conversations with this user."

    return StructuredTool.from_function(
        func=_remember,
        name="remember",
        description=(
            "Save a durable fact about THIS user to your long-term memory so you "
            "can recall it in future conversations — preferences, recurring "
            "projects, key people, decisions, important dates. Provide a short "
            "'name' (reuse it to update the same memory later), a one-line "
            "'summary' for your memory index, and the full 'content'. Save only "
            "things worth remembering long-term, not transient details."
        ),
        args_schema=_RememberArgs,
    )
