"""A user's skill pool and their per-agent assignments, backed by the store.

This module used to own a filesystem: it wrote `manifest.json`, created skill
folders under the user's workspace, copied enabled skills into each agent's
`skills/` directory and resolved default skills into `default_skills/`. All of
that was a *second* copy of content `chat_db` already held, kept in step by a
900-second reconciliation loop that read and hashed every user's entire tree
whether or not anything had changed.

Now it validates, and delegates storage to :mod:`harness.skill_registry.store`.
There is one copy of a skill, in ``agent_runtime``, and the mounts are virtual
routes over it — so there is nothing to copy and nothing to reconcile.

What stayed here is the part that was never about storage:

* **Validation.** Path shape, depth, extension allow-list, per-file and total
  size caps, strict base64. It all runs *before* anything is written, so a bad
  file cannot leave a half-written skill behind.
* **Frontmatter assembly.** ``SKILL.md``'s two scalars are serialised with
  ``yaml.safe_dump`` rather than interpolated — interpolation only stripped
  newlines, leaving every other YAML indicator free to change how the block
  parses. That mattered little when a human typed both values; it matters more
  now that ``create_skill`` lets an agent supply them.
* **The catalogue's two front doors** (plan 30): the search over the remote
  skills, and the Add of one — whose download and verification
  live in :mod:`harness.skill_registry.remote.fetch`, so this module only decides
  *whether* a skill may be added, never *how* its bytes are checked.
"""
from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any

import yaml

from core.logging import get_logger
from core.settings import settings
from harness.filesystem.layout import safe_segment as _safe_segment
from harness.memory.pool import get_memory_pool
from harness.skill_registry.remote import (
    SOURCES,
    fetch_remote_copy,
    get_source,
    source_label,
    upstream_url,
)
from harness.skill_registry.remote.client import RemoteSkillClient
from harness.skill_registry.store import (
    POOL_TYPE_CUSTOM,
    POOL_TYPE_GLOBAL,
    POOL_TYPE_REMOTE,
    SKILL_ENTRY_FILE,
    SkillStore,
    catalogue_query_terms,
)
from schema import (
    CatalogueSearchPage,
    CatalogueSkill,
    CustomSkillCreate,
    RemoteProvenance,
    RemoteSourceStatus,
    SkillFile,
    SkillManifestEntry,
    UserSkillDetail,
)

logger = get_logger(__name__)


class SkillNameConflict(ValueError):
    """A skill name collides with an entry already in the user's pool."""


class SkillValidationError(ValueError):
    """A custom-skill payload failed structural validation (path/size/type)."""


class RemoteSkillsDisabled(RuntimeError):
    """``REMOTE_SKILLS_ENABLED`` is off on this deployment. (→ 503)"""


# Multi-file custom-skill limits. A custom skill is a small folder of text +
# light binary assets — these caps keep a single create call from writing an
# unbounded amount of content.
_MAX_SKILL_FILES = 30
_MAX_SKILL_FILE_BYTES = 20 * 1024 * 1024         # 20 MiB per file
_MAX_SKILL_TOTAL_BYTES = 50 * 1024 * 1024        # 50 MiB per skill
_MAX_SKILL_PATH_DEPTH = 4
_TEXT_SKILL_EXTENSIONS = frozenset({
    ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".json",
    ".yaml", ".yml", ".csv", ".toml", ".sh", ".html", ".css",
})
_BINARY_SKILL_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf", ".ico", ".xlsx",
})
_ALLOWED_SKILL_EXTENSIONS = _TEXT_SKILL_EXTENSIONS | _BINARY_SKILL_EXTENSIONS


def _store() -> SkillStore:
    """The skill store on this service's ``agent_runtime`` pool.

    Borrowed from the same accessor agent memory uses — one pool for one
    database, rather than a second pool for three more tables.
    """
    return SkillStore(get_memory_pool())


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def _validate_skill_relpath(raw_path: str) -> PurePosixPath:
    """Validate one skill-relative file path into a safe ``PurePosixPath``.

    Rejects absolute paths, ``..``/leading-dot segments (via ``_safe_segment``),
    excessive depth, and disallowed extensions. Backslashes normalise to ``/`` so
    a Windows-authored upload path is handled consistently.
    """
    cleaned = (raw_path or "").strip().replace("\\", "/").lstrip("/")
    parts = [seg for seg in cleaned.split("/") if seg not in ("", ".")]
    if not parts:
        raise SkillValidationError(f"Empty or invalid file path: {raw_path!r}")
    if len(parts) > _MAX_SKILL_PATH_DEPTH:
        raise SkillValidationError(
            f"File path exceeds max depth {_MAX_SKILL_PATH_DEPTH}: {raw_path!r}"
        )
    for seg in parts:
        try:
            _safe_segment(seg)
        except ValueError as exc:
            raise SkillValidationError(str(exc)) from exc
    suffix = PurePosixPath(parts[-1]).suffix.lower()
    if suffix not in _ALLOWED_SKILL_EXTENSIONS:
        raise SkillValidationError(f"File type not allowed: {parts[-1]}")
    return PurePosixPath(*parts)


def _decode_skill_file(file: SkillFile, rel_key: str) -> bytes:
    """Decode a payload file to bytes, validating base64 strictly.

    ``validate=True`` matters: silent truncation of malformed base64 produces
    content that is corrupt in a way that is very hard to trace later.
    """
    if file.encoding == "base64":
        try:
            return base64.b64decode(file.content, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise SkillValidationError(f"Invalid base64 content for {rel_key}") from exc
    return file.content.encode("utf-8")


def _assemble_skill_md(name: str, description: str, body: str) -> str:
    """Build a ``SKILL.md`` string with canonical, YAML-safe frontmatter."""
    front = yaml.safe_dump(
        {
            "name": name.strip(),
            "description": description.replace("\n", " ").strip(),
        },
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
    ).strip()
    return f"---\n{front}\n---\n\n{body or ''}"


def _parse_skill_md(raw: str) -> tuple[str, str]:
    """Split a ``SKILL.md`` into ``(description, body)``.

    Best-effort: a skill whose frontmatter is missing or malformed still renders
    in the UI with an empty description rather than failing the read.
    """
    if not raw.startswith("---"):
        return "", raw
    parts = raw.split("---", 2)
    if len(parts) < 3:
        return "", raw
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        return "", parts[2].lstrip("\n")
    description = str(meta.get("description", "")) if isinstance(meta, dict) else ""
    return description, parts[2].lstrip("\n")


def _source_path(entry: dict[str, Any], user_id: str) -> str:
    """The display path the UI shows for a pool entry.

    Kept for the response contract only: nothing resolves content through it.
    """
    if entry["type"] == POOL_TYPE_GLOBAL:
        return f"global/{entry['category']}/{entry['name']}"
    if entry["type"] == POOL_TYPE_REMOTE:
        commit = (entry.get("source_commit") or "")[:12]
        return f"remote/{entry.get('source_id') or ''}/{entry['name']}@{commit}"
    return f"users/{user_id}/custom/{entry['name']}"


def _provenance(entry: dict[str, Any]) -> RemoteProvenance | None:
    """What a remote pool entry came from — ``None`` for every other kind."""
    if entry["type"] != POOL_TYPE_REMOTE:
        return None
    source_id = entry.get("source_id") or ""
    source = get_source(source_id)
    commit = entry.get("source_commit")
    return RemoteProvenance(
        source_id=source_id,
        source_label=source_label(source_id),
        commit=commit,
        licence=entry.get("licence"),
        upstream_url=upstream_url(source, entry["name"], commit) if source else None,
    )


def _as_manifest_entry(entry: dict[str, Any], user_id: str) -> SkillManifestEntry:
    added = entry.get("added_at")
    return SkillManifestEntry(
        name=entry["name"],
        type=entry["type"],
        description=entry.get("description", ""),
        source_path=_source_path(entry, user_id),
        category=entry.get("category", ""),
        origin=entry.get("origin", "user") or "user",
        created_by_agent=entry.get("created_by_agent"),
        created_at=added.isoformat() if isinstance(added, datetime) else None,
        provenance=_provenance(entry),
    )


# ---------------------------------------------------------------------------
# Pool reads
# ---------------------------------------------------------------------------
async def list_user_skills(user_id: str) -> list[SkillManifestEntry]:
    """Every skill in this user's pool."""
    entries = await _store().list_pool(user_id)
    return [_as_manifest_entry(entry, user_id) for entry in entries]


async def list_user_skill_names(user_id: str) -> list[str]:
    """Just the names — used to validate an agent spec's ``skills:`` list."""
    return [entry["name"] for entry in await _store().list_pool(user_id)]


async def get_user_skill_detail(user_id: str, skill_name: str) -> UserSkillDetail:
    """One pool entry joined with its file inventory.

    Raises ``FileNotFoundError`` when the user does not hold the skill — the
    route maps that to 404. Returning ``None`` instead would fail response
    validation against a non-Optional model and surface as a 500.
    """
    store = _store()
    entry = await store.get_pool_entry(user_id, skill_name)
    if entry is None:
        raise FileNotFoundError(f"Skill is not in the pool: {skill_name!r}")

    files = await store.read_files(user_id, skill_name)
    raw_entry = files.get(SKILL_ENTRY_FILE, ("", "utf-8"))[0]
    description, body = _parse_skill_md(raw_entry)

    return UserSkillDetail(
        name=entry["name"],
        type=entry["type"],
        description=entry.get("description") or description,
        source_path=_source_path(entry, user_id),
        category=entry.get("category", ""),
        content=body,
        files=[
            SkillFile(path=path, content=content, encoding=encoding)
            for path, (content, encoding) in sorted(files.items())
        ],
        provenance=_provenance(entry),
    )


# ---------------------------------------------------------------------------
# Pool writes
# ---------------------------------------------------------------------------
async def add_custom_to_user(
    user_id: str,
    payload: CustomSkillCreate,
    *,
    created_by_agent: str | None = None,
) -> SkillManifestEntry:
    """Create a user-authored skill from a multi-file payload.

    Exactly one file must be ``SKILL.md``; its body is wrapped with canonical
    frontmatter. Every file is validated and decoded **before** anything is
    written, so a bad file cannot leave a partial skill behind.

    Raises :class:`SkillNameConflict` when the pool already holds the name (→ 409) and
    :class:`SkillValidationError` on a bad path/size/type/base64 (→ 422).
    """
    name = (payload.name or "").strip()
    if not name:
        raise SkillValidationError("A skill needs a name.")
    try:
        _safe_segment(name)
    except ValueError as exc:
        raise SkillValidationError(str(exc)) from exc

    store = _store()
    if await store.get_pool_entry(user_id, name) is not None:
        raise SkillNameConflict(f"Skill already in the pool: {name!r}")

    if len(payload.files) > _MAX_SKILL_FILES:
        raise SkillValidationError(f"A skill may have at most {_MAX_SKILL_FILES} files.")

    # Validate and decode everything first — nothing is written until the whole
    # payload is known good.
    staged: dict[str, tuple[str, str]] = {}
    total = 0
    entry_seen = False
    for file in payload.files:
        rel = _validate_skill_relpath(file.path).as_posix()
        if rel in staged:
            raise SkillValidationError(f"Duplicate file path: {rel}")
        raw = _decode_skill_file(file, rel)
        if len(raw) > _MAX_SKILL_FILE_BYTES:
            raise SkillValidationError(f"File exceeds the per-file size limit: {rel}")
        total += len(raw)
        if total > _MAX_SKILL_TOTAL_BYTES:
            raise SkillValidationError("Skill exceeds the total size limit.")

        if rel == SKILL_ENTRY_FILE:
            entry_seen = True
            body = raw.decode("utf-8", errors="replace")
            _, existing_body = _parse_skill_md(body)
            staged[rel] = (
                _assemble_skill_md(name, payload.description, existing_body or body),
                "utf-8",
            )
        elif file.encoding == "base64":
            staged[rel] = (base64.b64encode(raw).decode("ascii"), "base64")
        else:
            staged[rel] = (raw.decode("utf-8", errors="replace"), "utf-8")

    if not entry_seen:
        raise SkillValidationError(f"A skill must include a {SKILL_ENTRY_FILE} file.")

    await store.add_custom(
        user_id,
        name,
        files=staged,
        description=payload.description,
        origin="agent" if created_by_agent else "user",
        created_by_agent=created_by_agent,
    )
    logger.info(
        "skill_pool_custom_created",
        "Created a user-authored skill",
        user_id=user_id,
        skill_name=name,
        file_count=len(staged),
        created_by_agent=created_by_agent,
    )
    return _as_manifest_entry(
        {
            "name": name,
            "type": POOL_TYPE_CUSTOM,
            "category": "",
            "description": payload.description,
            "origin": "agent" if created_by_agent else "user",
            "created_by_agent": created_by_agent,
            "added_at": datetime.now(timezone.utc),
        },
        user_id,
    )


async def add_remote_to_user(user_id: str, source_id: str, skill_id: str) -> SkillManifestEntry:
    """Add a remote skill to this user's pool, downloading it if nobody has yet.

    The decision is made against the catalogue row the user was shown: it must
    exist, have passed every gate, and not be withdrawn. Then either the shared
    copy already exists (one row, O(1)) or :func:`fetch_remote_copy` downloads
    and verifies it — and the copy and the pool row are written together.

    Raises ``FileNotFoundError`` (→ 404) for an unknown, refused or withdrawn
    skill, :class:`SkillNameConflict` (→ 409) when the name is already in the
    pool, ``RemoteSkillRefused`` (→ 422) when the download fails a check,
    ``RemoteSkillUnavailable`` (→ 502) when the source cannot be read, and
    :class:`RemoteSkillsDisabled` (→ 503) when the feature is off.
    """
    if not settings.remote_skills.enabled:
        raise RemoteSkillsDisabled("Remote skill sources are not enabled.")
    source = get_source(source_id)
    if source is None:
        raise FileNotFoundError(f"Unknown skill source: {source_id!r}")

    store = _store()
    entry = await store.get_catalogue_entry(source_id, skill_id)
    if entry is None or entry.get("refusal") or entry.get("withdrawn_at"):
        # One answer for all three: a refused skill must be as unreachable as
        # one that does not exist, so the reason is not an oracle.
        raise FileNotFoundError(f"Unknown remote skill: {source_id}/{skill_id}")
    if await store.get_pool_entry(user_id, skill_id) is not None:
        raise SkillNameConflict(f"Skill already in the pool: {skill_id!r}")

    files = None
    if not await store.has_remote_copy(source_id, skill_id, entry["content_ref"]):
        async with RemoteSkillClient() as client:
            files = await fetch_remote_copy(store, client, source, entry)

    await store.add_remote(
        user_id,
        skill_id,
        source_id=source_id,
        content_ref=entry["content_ref"],
        source_commit=entry["source_ref"],
        licence=entry.get("licence"),
        category=entry.get("category") or "",
        description=entry.get("description") or "",
        files=files,
    )
    logger.info(
        "skill_pool_remote_added",
        "Added a remote skill to a user's pool",
        user_id=user_id,
        skill_name=skill_id,
        source_id=source_id,
        source_commit=(entry["source_ref"] or "")[:12],
        downloaded=files is not None,
        file_count=len(files) if files else 0,
    )
    return _as_manifest_entry(
        {
            "name": skill_id,
            "type": POOL_TYPE_REMOTE,
            "category": entry.get("category") or "",
            "description": entry.get("description") or "",
            "origin": "user",
            "created_by_agent": None,
            "added_at": datetime.now(timezone.utc),
            "source_id": source_id,
            "source_ref": entry["content_ref"],
            "source_commit": entry["source_ref"],
            "licence": entry.get("licence"),
        },
        user_id,
    )


async def remove_from_user(user_id: str, skill_name: str) -> None:
    """Drop a skill from the pool, with its files and every agent assignment."""
    removed = await _store().remove(user_id, skill_name)
    logger.info(
        "skill_pool_removed",
        "Removed a skill from a user's pool",
        user_id=user_id,
        skill_name=skill_name,
        was_present=removed,
    )


# ---------------------------------------------------------------------------
# The catalogue (plan 30)
# ---------------------------------------------------------------------------
def _as_catalogue_skill(row: dict[str, Any]) -> CatalogueSkill:
    source_id = row["source_id"]
    source = get_source(source_id)
    return CatalogueSkill(
        source_id=source_id,
        source_label=source_label(source_id),
        skill_id=row["skill_id"],
        name=row["name"],
        description=row.get("description") or "",
        category=row.get("category") or "",
        licence=row.get("licence"),
        commit=row.get("source_ref"),
        upstream_url=upstream_url(source, row["skill_id"], row.get("source_ref")) if source else None,
    )


async def search_catalogue(
    query: str, *, source_id: str | None = None, limit: int = 10, offset: int = 0
) -> CatalogueSearchPage:
    """Full-text search over the admitted remote skills — the whole catalogue.

    Empty while the feature is off: nothing could be added from it, so showing
    rows would only produce dead buttons. A source that is not on the allowlist
    (a row left behind by a removed source) is never returned.
    """
    remote_enabled = settings.remote_skills.enabled
    if not remote_enabled or (source_id is not None and get_source(source_id) is None):
        return CatalogueSearchPage(limit=limit, offset=offset, remote_enabled=remote_enabled)
    rows, total = await _store().search_catalogue(
        catalogue_query_terms(query),
        source_ids=[source_id] if source_id else [source.source_id for source in SOURCES],
        limit=limit,
        offset=offset,
    )
    return CatalogueSearchPage(
        results=[_as_catalogue_skill(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
        remote_enabled=remote_enabled,
    )


async def list_remote_sources() -> list[RemoteSourceStatus]:
    """Every allowlisted source with its last sync outcome — the ops view."""
    states = {state["source_id"]: state for state in await _store().list_source_states()}
    out: list[RemoteSourceStatus] = []
    for source in SOURCES:
        state = states.get(source.source_id) or {}
        synced = state.get("synced_at")
        out.append(RemoteSourceStatus(
            source_id=source.source_id,
            label=source.label,
            kind=source.kind,
            source_ref=state.get("source_ref") or None,
            synced_at=synced.isoformat() if isinstance(synced, datetime) else None,
            last_error=state.get("last_error"),
            skill_count=int(state.get("skill_count") or 0),
            admitted_count=int(state.get("admitted_count") or 0),
        ))
    return out


# ---------------------------------------------------------------------------
# Per-agent assignment (tier ②)
# ---------------------------------------------------------------------------
async def list_user_agent_skills(user_id: str, agent_slug: str) -> list[str]:
    """Skills this user switched on for this agent."""
    return await _store().list_agent_skills(user_id, agent_slug)


async def assign_user_skill_to_agent(user_id: str, agent_slug: str, skill_name: str) -> None:
    """Switch a pool skill on for one agent.

    Refuses a name the user does not hold: an assignment with nothing behind it
    would mount a skill folder that resolves to no files.
    """
    store = _store()
    if await store.get_pool_entry(user_id, skill_name) is None:
        raise FileNotFoundError(f"Skill is not in the pool: {skill_name!r}")
    await store.assign(user_id, agent_slug, skill_name)


async def unassign_user_skill_from_agent(user_id: str, agent_slug: str, skill_name: str) -> None:
    """Switch a skill off for one agent. The pool entry is untouched."""
    await _store().unassign(user_id, agent_slug, skill_name)


__all__ = [
    "RemoteSkillsDisabled",
    "SkillNameConflict",
    "SkillValidationError",
    "add_custom_to_user",
    "add_remote_to_user",
    "assign_user_skill_to_agent",
    "get_user_skill_detail",
    "list_user_agent_skills",
    "list_user_skill_names",
    "list_remote_sources",
    "list_user_skills",
    "remove_from_user",
    "search_catalogue",
    "unassign_user_skill_from_agent",
]
