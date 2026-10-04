"""The agents service's part of a user's data export (plan 27).

The bridge builds the export archive, but a user's custom agents and skills live
here, in ``agent_runtime``. This module streams them to the bridge as a framed
NDJSON sequence the bridge copies straight into the zip — so the agents service
decides the layout under ``agents/`` and ``skills/``, and neither side ever holds
more than one small piece of it.

Frames, one JSON object per line:

* ``{"op": "open", "path": "...", "encoding": "utf-8"|"base64"}`` — start a file.
* ``{"op": "data", "text": "..."}`` — the next piece of it (≤ 1 MiB of text).
* ``{"op": "close"}`` — end that file.
* ``{"op": "end"}`` — the whole stream is complete. Its absence tells the bridge
  the stream was cut, so a truncated export can never pass for a complete one.

Memory stays flat because everything is paged: rows come in pages of
:data:`PAGE_ROWS` by keyset (each page one short indexed query, no transaction
held between pages), and file contents in slices of :data:`SLICE_CHARS`.

**Not exported**, deliberately: agent memories (the user chose so), and the
shared copies of remote skills — those are third-party content anyone can
download again, so a remote skill appears as a reference with its provenance.
"""
from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any, AsyncIterator, Awaitable, Callable

from core.logging import get_logger
from harness.agent_registry.store import AgentDefinitionStore
from harness.memory.pool import get_memory_pool
from harness.skill_registry.remote import get_source, upstream_url
from harness.skill_registry.store import POOL_TYPE_REMOTE, SkillStore

logger = get_logger(__name__)

#: Rows per keyset page.
PAGE_ROWS = 100
#: Characters per content slice. A multiple of 4, so every slice of a base64
#: file decodes on its own and the bridge never has to rejoin them first.
SLICE_CHARS = 1024 * 1024


def _json_default(value: Any) -> str:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    raise TypeError(f"not JSON serialisable: {type(value).__name__}")


def _frame(obj: dict[str, Any]) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default) + "\n").encode("utf-8")


def _record(obj: dict[str, Any]) -> bytes:
    """One NDJSON record line, carried inside a ``data`` frame."""
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default) + "\n"
    return _frame({"op": "data", "text": line})


async def _stream_file(
    path: str,
    encoding: str,
    read_slice: Callable[[int, int], Awaitable[str]],
) -> AsyncIterator[bytes]:
    """One file as open / data… / close, read slice by slice until a short slice."""
    yield _frame({"op": "open", "path": path, "encoding": "base64" if encoding == "base64" else "utf-8"})
    start = 1
    while True:
        part = await read_slice(start, SLICE_CHARS)
        if part:
            yield _frame({"op": "data", "text": part})
        if len(part) < SLICE_CHARS:
            break
        start += SLICE_CHARS
    yield _frame({"op": "close"})


def _skill_record(entry: dict[str, Any]) -> dict[str, Any]:
    """A pool entry as exported. Remote ones carry their provenance, not content."""
    record = {
        "name": entry["name"],
        "type": entry["type"],
        "description": entry.get("description") or "",
        "category": entry.get("category") or "",
        "origin": entry.get("origin") or "user",
        "created_by_agent": entry.get("created_by_agent"),
        "added_at": entry.get("added_at"),
    }
    if entry["type"] == POOL_TYPE_REMOTE:
        source = get_source(entry.get("source_id") or "")
        record.update(
            source_id=entry.get("source_id"),
            source_commit=entry.get("source_commit"),
            licence=entry.get("licence"),
            upstream_url=upstream_url(source, entry["name"], entry.get("source_commit")) if source else None,
        )
    return record


async def stream_user_export(user_id: str) -> AsyncIterator[bytes]:
    """Every framed piece of this user's agents and skills, in archive order."""
    pool = get_memory_pool()
    definitions = AgentDefinitionStore(pool)
    skills = SkillStore(pool)
    counts = {"agents": 0, "agent_files": 0, "skills": 0, "skill_files": 0, "assignments": 0}

    # agents/agents.ndjson — the specs.
    yield _frame({"op": "open", "path": "agents/agents.ndjson", "encoding": "utf-8"})
    after_slug = ""
    while True:
        page = await definitions.page_definitions(user_id, after_slug, PAGE_ROWS)
        for row in page:
            counts["agents"] += 1
            yield _record({
                "slug": row["agent_slug"], "spec": row["spec"],
                "created_at": row["created_at"], "updated_at": row["updated_at"],
            })
        if len(page) < PAGE_ROWS:
            break
        after_slug = page[-1]["agent_slug"]
    yield _frame({"op": "close"})

    # agents/<slug>/<path> — each authored file, sliced.
    after: tuple[str, str] = ("", "")
    while True:
        refs = await definitions.page_file_refs(user_id, after, PAGE_ROWS)
        for ref in refs:
            counts["agent_files"] += 1
            slug, rel = ref["agent_slug"], ref["path"]

            async def read(start: int, length: int, slug: str = slug, rel: str = rel) -> str:
                return await definitions.read_file_slice(user_id, slug, rel, start, length)

            async for frame in _stream_file(f"agents/{slug}/{rel}", ref["encoding"], read):
                yield frame
        if len(refs) < PAGE_ROWS:
            break
        after = (refs[-1]["agent_slug"], refs[-1]["path"])

    # skills/skills.ndjson — every pool entry; remote ones as references.
    yield _frame({"op": "open", "path": "skills/skills.ndjson", "encoding": "utf-8"})
    after_name = ""
    while True:
        page = await skills.page_pool_entries(user_id, after_name, PAGE_ROWS)
        for entry in page:
            counts["skills"] += 1
            yield _record(_skill_record(entry))
        if len(page) < PAGE_ROWS:
            break
        after_name = page[-1]["name"]
    yield _frame({"op": "close"})

    # skills/<name>/<path> — custom skills' own files, sliced.
    after = ("", "")
    while True:
        refs = await skills.page_custom_file_refs(user_id, after, PAGE_ROWS)
        for ref in refs:
            counts["skill_files"] += 1
            name, rel = ref["skill_name"], ref["path"]

            async def read(start: int, length: int, name: str = name, rel: str = rel) -> str:
                return await skills.read_custom_file_slice(user_id, name, rel, start, length)

            async for frame in _stream_file(f"skills/{name}/{rel}", ref["encoding"], read):
                yield frame
        if len(refs) < PAGE_ROWS:
            break
        after = (refs[-1]["skill_name"], refs[-1]["path"])

    # skills/assignments.ndjson — which skill is switched on for which agent.
    yield _frame({"op": "open", "path": "skills/assignments.ndjson", "encoding": "utf-8"})
    after = ("", "")
    while True:
        page = await skills.page_assignments(user_id, after, PAGE_ROWS)
        for row in page:
            counts["assignments"] += 1
            yield _record({"agent_slug": row["agent_slug"], "skill_name": row["skill_name"],
                           "assigned_at": row["assigned_at"]})
        if len(page) < PAGE_ROWS:
            break
        after = (page[-1]["agent_slug"], page[-1]["skill_name"])
    yield _frame({"op": "close"})

    yield _frame({"op": "end", "counts": counts})
    logger.info("user_export_streamed", "Streamed a user's agents and skills for export",
                user_id=user_id, **counts)


__all__ = ["PAGE_ROWS", "SLICE_CHARS", "stream_user_export"]
