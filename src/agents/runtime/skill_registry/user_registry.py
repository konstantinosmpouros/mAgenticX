"""Per-user skill registry — manifest + custom-skill authoring + lifecycle.

Layout::

    $SKILLS_REGISTRY_USERS_ROOT/<user_id>/
        manifest.json          ← UserManifest: list of {name, type, description, source_path}
        custom/
            <skill_name>/
                SKILL.md       ← user-authored body with assembled frontmatter

Source-of-truth rules:

- ``manifest.json`` is the authoritative list of "what skills does this user
  have in their pool." Without it, the user has no skills.
- ``type="custom"`` entries are backed by a folder under ``custom/``. The
  folder is owned by the user and persists until they explicitly delete it.
- ``type="global"`` entries are *references* — no folder lives in the user
  volume for them. The agents service resolves their content via the
  global registry volume at request time.

Concurrency / atomicity:

- Manifest writes go through ``_write_user_manifest_atomic`` (tmp + replace).
- Name collisions are rejected by all writers — a skill name is unique
  within a user's pool, and cannot shadow a global skill either (because
  the per-(user, agent) target dir is keyed by name only and a collision
  would corrupt the copied folder).

Reconciliation:

- ``reconcile_user_manifest`` is called on agents-service boot for every
  existing user dir. It heals manifest-vs-filesystem drift caused by
  crash-mid-write or out-of-band volume edits:
  * Missing/corrupt manifest → empty replacement.
  * Orphan ``custom/<name>/`` on disk not in manifest → entry added.
  * Manifest ``custom`` entries with missing folder → entry dropped.
  * ``type="global"`` entries are trusted (no folder backs them).
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import Iterable

from core.settings import settings
from core.logging import get_logger
from runtime.filesystem import layout
from runtime.filesystem.provisioner import _safe_segment
from runtime.skill_registry.global_manifest import get_global_manifest, is_global_skill
from schemas import (
    CustomSkillCreate,
    SkillFile,
    SkillManifestEntry,
    UserManifest,
    UserSkillDetail,
)

logger = get_logger(__name__)

_MANIFEST_FILENAME = "manifest.json"


class SkillNameConflict(ValueError):
    """A custom skill name collides with an existing pool entry or a global."""


class SkillValidationError(ValueError):
    """A custom-skill payload failed structural validation (path/size/type)."""


# Multi-file custom-skill limits. A custom skill is a small folder of text +
# light binary assets — these caps keep a single create call from writing an
# unbounded tree into the user volume.
_SKILL_ENTRY_FILE = "SKILL.md"
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


def _validate_skill_relpath(raw_path: str) -> PurePosixPath:
    """Validate a single skill-relative file path into a safe PurePosixPath.

    Rejects absolute paths, ``..``/leading-dot segments (via ``_safe_segment``),
    excessive depth, and disallowed extensions. Backslashes are normalized to
    ``/`` so a Windows-authored upload path is handled consistently.
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
    """Decode a payload file to bytes, validating base64 strictly."""
    if file.encoding == "base64":
        try:
            return base64.b64decode(file.content, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise SkillValidationError(f"Invalid base64 content for {rel_key}") from exc
    return file.content.encode("utf-8")


def _collect_skill_files(folder: Path) -> list[SkillFile]:
    """Walk a skill folder into a ``SkillFile`` inventory for the detail view.

    Text files under the per-file cap are returned with inline UTF-8 content;
    binary or oversized files return metadata only (``content=""``) so the
    detail payload stays bounded.
    """
    out: list[SkillFile] = []
    for path in sorted(folder.rglob("*")):
        if not path.is_file():
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue
        rel = path.relative_to(folder).as_posix()
        suffix = path.suffix.lower()
        if suffix in _TEXT_SKILL_EXTENSIONS and size <= _MAX_SKILL_FILE_BYTES:
            try:
                text = path.read_text(encoding="utf-8")
                out.append(SkillFile(path=rel, content=text, encoding="utf-8", size=size))
                continue
            except (OSError, UnicodeDecodeError):
                pass
        out.append(SkillFile(path=rel, content="", encoding="base64", size=size))
    return out


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------
def _user_root(user_id: str) -> Path:
    """The user's skill pool — now a subtree of their workspace rather than a
    separate volume (see ``runtime.filesystem.layout``)."""
    return layout.user_skills_pool_root(user_id)


def _manifest_path(user_id: str) -> Path:
    return layout.user_manifest_path(user_id)


def _custom_root(user_id: str) -> Path:
    return layout.user_custom_skills_root(user_id)


def _custom_skill_dir(user_id: str, skill_name: str) -> Path:
    return layout.user_custom_skill_dir(user_id, skill_name)


def _global_skill_dir_from_source_path(source_path: str) -> Path:
    """Resolve ``global/<category>/<skill_name>`` to its on-disk folder.

    Validates every path segment with ``_safe_segment`` so a corrupted
    manifest can't break out of the global root via ``..`` or absolute
    paths injected into ``source_path``.
    """
    parts = source_path.split("/")
    if len(parts) < 2 or parts[0] != "global":
        raise ValueError(f"Unexpected global source_path: {source_path!r}")
    relative = parts[1:]  # category, skill_name (plus any future depth)
    resolved = layout.global_skills_root()
    for segment in relative:
        resolved = resolved / _safe_segment(segment)
    return resolved


# ---------------------------------------------------------------------------
# Filesystem provisioning
# ---------------------------------------------------------------------------
def ensure_user_registry(user_id: str) -> Path:
    """Idempotent. Returns the per-user root and seeds manifest.json if missing."""
    root = _user_root(user_id)
    root.mkdir(parents=True, exist_ok=True)
    _custom_root(user_id).mkdir(parents=True, exist_ok=True)
    if not _manifest_path(user_id).exists():
        _write_user_manifest_atomic(user_id, UserManifest())
    return root


def _write_user_manifest_atomic(user_id: str, manifest: UserManifest) -> None:
    target = _manifest_path(user_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = manifest.model_dump_json(indent=2)
    fd, tmp_path_str = tempfile.mkstemp(
        prefix=".manifest.",
        suffix=".tmp",
        dir=str(target.parent),
    )
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
        os.replace(tmp_path, target)
    except Exception:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
        raise


def read_user_manifest(user_id: str) -> UserManifest:
    """Return the user's manifest. Empty manifest if missing or unparseable."""
    path = _manifest_path(user_id)
    if not path.is_file():
        return UserManifest()
    try:
        raw = path.read_text(encoding="utf-8")
        return UserManifest.model_validate_json(raw)
    except (OSError, ValueError):
        logger.warning(
            "user_manifest_unparseable",
            "User manifest could not be parsed; returning empty",
            user_id=user_id,
            path=str(path),
            exc_info=True,
        )
        return UserManifest()


# ---------------------------------------------------------------------------
# Content readers
# ---------------------------------------------------------------------------
def _parse_skill_md(skill_md: Path) -> tuple[str, str, str]:
    """Return ``(name, description, body)`` parsed from a SKILL.md file.

    Mirrors the loose frontmatter parser used elsewhere — only ``name`` and
    ``description`` are extracted; the body is everything after the closing
    fence (or the whole file if no frontmatter).
    """
    name = skill_md.parent.name
    description = ""
    try:
        raw = skill_md.read_text(encoding="utf-8")
    except OSError:
        return name, description, ""

    if not raw.startswith("---\n"):
        return name, description, raw
    end = raw.find("\n---\n", 4)
    if end == -1:
        return name, description, raw

    for line in raw[4:end].splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip().strip("\"'")
        if key == "name" and value:
            name = value
        elif key == "description":
            description = value
    body = raw[end + 5 :].lstrip("\n")
    return name, description, body


def resolve_skill_path(user_id: str, skill_name: str) -> Path:
    """Resolve a skill name in the user's pool to its on-disk folder.

    Raises ``FileNotFoundError`` if the skill isn't in the user's manifest
    or the resolved folder doesn't exist.
    """
    manifest = read_user_manifest(user_id)
    entry = next((s for s in manifest.skills if s.name == skill_name), None)
    if entry is None:
        raise FileNotFoundError(f"Skill not in user pool: {skill_name}")

    if entry.type == "global":
        folder = _global_skill_dir_from_source_path(entry.source_path)
    else:
        folder = _custom_skill_dir(user_id, entry.source_path.rsplit("/", 1)[-1])

    if not folder.is_dir():
        raise FileNotFoundError(
            f"Skill folder missing on disk for {skill_name!r} at {folder}"
        )
    return folder


def get_user_skill_detail(user_id: str, skill_name: str) -> UserSkillDetail:
    """Manifest entry joined with SKILL.md content for a single skill."""
    manifest = read_user_manifest(user_id)
    entry = next((s for s in manifest.skills if s.name == skill_name), None)
    if entry is None:
        raise FileNotFoundError(f"Skill not in user pool: {skill_name}")

    folder = resolve_skill_path(user_id, skill_name)
    skill_md = folder / _SKILL_ENTRY_FILE
    _, _, body = _parse_skill_md(skill_md) if skill_md.is_file() else ("", "", "")
    return UserSkillDetail(
        name=entry.name,
        type=entry.type,
        description=entry.description,
        source_path=entry.source_path,
        category=entry.category,
        content=body,
        files=_collect_skill_files(folder),
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------
def _names_in_use(manifest: UserManifest) -> set[str]:
    return {s.name for s in manifest.skills}


def add_global_to_user(user_id: str, skill_name: str) -> SkillManifestEntry:
    """Append a reference to a global skill into the user's manifest.

    Raises ``FileNotFoundError`` if the skill isn't in the global manifest;
    ``ValueError`` if a name collision exists in the user's pool.
    """
    if not is_global_skill(skill_name):
        raise FileNotFoundError(f"Skill not in global registry: {skill_name}")

    ensure_user_registry(user_id)
    manifest = read_user_manifest(user_id)
    if skill_name in _names_in_use(manifest):
        raise ValueError(f"Skill already in user pool: {skill_name}")

    # Look up the global entry to copy description + canonical source_path.
    global_entry = next(
        (e for e in get_global_manifest().skills if e.name == skill_name),
        None,
    )
    if global_entry is None:
        raise FileNotFoundError(f"Skill not in global registry: {skill_name}")

    entry = SkillManifestEntry(
        name=global_entry.name,
        type="global",
        description=global_entry.description,
        source_path=global_entry.source_path,
        category=global_entry.category,
    )
    manifest.skills.append(entry)
    _write_user_manifest_atomic(user_id, manifest)
    logger.info(
        "user_skill_global_added",
        "Added global skill reference to user pool",
        user_id=user_id,
        skill_name=skill_name,
    )
    return entry


def _assemble_skill_md(name: str, description: str, body: str) -> str:
    """Build a SKILL.md string with canonical frontmatter."""
    safe_desc = description.replace("\n", " ").strip()
    safe_name = name.strip()
    return f"---\nname: {safe_name}\ndescription: {safe_desc}\n---\n\n{body or ''}"


def add_custom_to_user(user_id: str, payload: CustomSkillCreate) -> SkillManifestEntry:
    """Create a new custom skill folder (multi-file) + manifest entry.

    The payload carries a list of files; exactly one must be ``SKILL.md`` (its
    body is wrapped with canonical frontmatter). Every file is validated and
    decoded *before* anything is written, so a bad file can't leave a partial
    folder behind. Raises:

    - :class:`SkillNameConflict` on a name/global/folder collision (→ 409).
    - :class:`SkillValidationError` on a bad path/size/type/base64 (→ 422).
    """
    try:
        name = _safe_segment(payload.name.strip())
    except ValueError as exc:
        raise SkillValidationError(str(exc)) from exc
    ensure_user_registry(user_id)
    manifest = read_user_manifest(user_id)

    if name in _names_in_use(manifest):
        raise SkillNameConflict(f"Skill name already in user pool: {name}")
    if is_global_skill(name):
        raise SkillNameConflict(f"Skill name collides with a global skill: {name}")

    skill_dir = _custom_skill_dir(user_id, name)
    if skill_dir.exists():
        raise SkillNameConflict(f"Custom skill folder already exists: {name}")

    files = payload.files or []
    if not files:
        raise SkillValidationError("A custom skill must include at least a SKILL.md file.")
    if len(files) > _MAX_SKILL_FILES:
        raise SkillValidationError(f"Too many files ({len(files)}); max is {_MAX_SKILL_FILES}.")

    resolved: list[tuple[PurePosixPath, bytes, bool]] = []
    seen: set[str] = set()
    total = 0
    skill_md_body: str | None = None
    for file in files:
        rel = _validate_skill_relpath(file.path)
        key = rel.as_posix()
        if key in seen:
            raise SkillValidationError(f"Duplicate file path: {key}")
        seen.add(key)
        data = _decode_skill_file(file, key)
        if len(data) > _MAX_SKILL_FILE_BYTES:
            raise SkillValidationError(f"File too large: {key}")
        total += len(data)
        if total > _MAX_SKILL_TOTAL_BYTES:
            raise SkillValidationError("Skill exceeds the total size limit.")
        is_entry = key == _SKILL_ENTRY_FILE
        if is_entry:
            skill_md_body = (
                file.content if file.encoding == "utf-8" else data.decode("utf-8", "replace")
            )
        resolved.append((rel, data, is_entry))

    if skill_md_body is None:
        raise SkillValidationError("A SKILL.md file is required.")

    skill_dir.mkdir(parents=True, exist_ok=True)
    try:
        for rel, data, is_entry in resolved:
            target = skill_dir.joinpath(*rel.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if is_entry:
                target.write_text(
                    _assemble_skill_md(name, payload.description, skill_md_body),
                    encoding="utf-8",
                )
            else:
                target.write_bytes(data)
    except OSError:
        shutil.rmtree(skill_dir, ignore_errors=True)
        raise

    entry = SkillManifestEntry(
        name=name,
        type="custom",
        description=payload.description,
        source_path=f"users/{user_id}/custom/{name}",
    )
    manifest.skills.append(entry)
    _write_user_manifest_atomic(user_id, manifest)
    logger.info(
        "user_skill_custom_created",
        "Created custom skill in user pool",
        user_id=user_id,
        skill_name=name,
        file_count=len(resolved),
    )
    return entry


def _cascade_remove_from_agent_assignments(user_id: str, skill_name: str) -> None:
    """Remove the skill folder from every ``agents/*/skills/<name>/`` for this user.

    Idempotent. Iterates the user's workspace under ``agents/`` and removes any
    matching skill directory. Missing dirs are tolerated.
    """
    safe_skill = _safe_segment(skill_name)
    agents_parent = layout.user_agents_root(user_id)
    if not agents_parent.is_dir():
        return
    for agent_dir in agents_parent.iterdir():
        if not agent_dir.is_dir():
            continue
        target = agent_dir / "skills" / safe_skill
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)


def remove_from_user(user_id: str, skill_name: str) -> None:
    """Remove a skill from the user's pool, cascading to per-agent assignments.

    - Manifest entry removed.
    - ``type=custom`` → folder under ``custom/<name>/`` is rmtree'd.
    - ``type=global`` → no user-volume folder to delete.
    - Per-(user, agent) ``skills/<name>/`` copies are unconditionally removed.
    """
    ensure_user_registry(user_id)
    manifest = read_user_manifest(user_id)
    entry = next((s for s in manifest.skills if s.name == skill_name), None)
    if entry is None:
        # Idempotent on missing — but still cascade in case of drift.
        _cascade_remove_from_agent_assignments(user_id, skill_name)
        return

    manifest.skills = [s for s in manifest.skills if s.name != skill_name]
    _write_user_manifest_atomic(user_id, manifest)

    if entry.type == "custom":
        skill_dir = _custom_skill_dir(user_id, skill_name)
        if skill_dir.exists():
            shutil.rmtree(skill_dir, ignore_errors=True)

    _cascade_remove_from_agent_assignments(user_id, skill_name)
    logger.info(
        "user_skill_removed",
        "Removed skill from user pool with per-agent cascade",
        user_id=user_id,
        skill_name=skill_name,
        type=entry.type,
    )


# ---------------------------------------------------------------------------
# Reconciliation (lifespan)
# ---------------------------------------------------------------------------
def reconcile_user_manifest(user_id: str) -> UserManifest:
    """Heal manifest-vs-filesystem drift for one user dir."""
    ensure_user_registry(user_id)
    manifest = read_user_manifest(user_id)
    custom_root = _custom_root(user_id)

    on_disk_custom = {
        p.name
        for p in custom_root.iterdir()
        if p.is_dir() and (p / "SKILL.md").is_file()
    } if custom_root.is_dir() else set()

    in_manifest_custom = {s.name for s in manifest.skills if s.type == "custom"}

    # Drop custom entries whose folder is gone.
    surviving: list[SkillManifestEntry] = []
    dropped: list[str] = []
    for entry in manifest.skills:
        if entry.type == "custom" and entry.name not in on_disk_custom:
            dropped.append(entry.name)
            continue
        surviving.append(entry)

    # Adopt orphan custom folders not yet in manifest.
    adopted: list[str] = []
    for orphan_name in sorted(on_disk_custom - in_manifest_custom):
        name, description, _ = _parse_skill_md(custom_root / orphan_name / "SKILL.md")
        surviving.append(
            SkillManifestEntry(
                name=name,
                type="custom",
                description=description,
                source_path=f"users/{user_id}/custom/{orphan_name}",
            )
        )
        adopted.append(orphan_name)

    healed = UserManifest(version=manifest.version or 1, skills=surviving)
    _write_user_manifest_atomic(user_id, healed)

    if dropped or adopted:
        logger.info(
            "user_manifest_reconciled",
            "Reconciled user manifest against filesystem state",
            user_id=user_id,
            dropped=dropped,
            adopted=adopted,
        )
    return healed


def reconcile_all_user_manifests() -> None:
    """Walk every existing user dir and reconcile its manifest.

    Called from the agents-service FastAPI lifespan on every boot. New users
    (no dir yet) are not provisioned here — they're created lazily on first
    POST. We only heal existing state.
    """
    users_root = layout.users_root()
    if not users_root.is_dir():
        users_root.mkdir(parents=True, exist_ok=True)
        return

    reconciled = 0
    for user_dir in users_root.iterdir():
        if not user_dir.is_dir():
            continue
        try:
            reconcile_user_manifest(user_dir.name)
            reconciled += 1
        except Exception:
            logger.warning(
                "user_manifest_reconcile_failed",
                "Failed to reconcile user manifest",
                user_id=user_dir.name,
                exc_info=True,
            )
    logger.info(
        "user_manifests_reconciled",
        "Per-user manifest reconciliation pass completed",
        count=reconciled,
    )


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------
def list_user_skills(user_id: str) -> list[SkillManifestEntry]:
    """Manifest entries for a user (no content)."""
    return list(read_user_manifest(user_id).skills)


def _enable_skill_for_agent(
    *,
    user_id: str,
    agent_slug: str,
    skill_name: str,
) -> None:
    """Copy a user-pool skill into the per-(user, agent) skills directory.

    Resolves the source via the user's manifest (global or custom). 404 if
    the skill isn't in the user's pool.
    """
    src = resolve_skill_path(user_id, skill_name)
    dest_parent = layout.agent_skills_root(user_id, agent_slug)
    dest_parent.mkdir(parents=True, exist_ok=True)
    dest = dest_parent / _safe_segment(skill_name)
    if dest.exists():
        return  # idempotent
    shutil.copytree(src, dest)
    logger.info(
        "user_agent_skill_assigned",
        "Copied user-pool skill into per-(user, agent) skills dir",
        user_id=user_id,
        agent_slug=agent_slug,
        skill_name=skill_name,
        source_path=str(src),
    )


def assign_user_skill_to_agent(
    *,
    user_id: str,
    agent_slug: str,
    skill_name: str,
) -> None:
    """Public assignment entry point — resolves via manifest, copies folder."""
    _enable_skill_for_agent(
        user_id=user_id,
        agent_slug=agent_slug,
        skill_name=skill_name,
    )


def sync_agent_default_skills(
    *,
    user_id: str,
    agent_slug: str,
    skill_names: Iterable[str],
) -> list[str]:
    """Mirror a user-authored agent's declared ``skills:`` into its tier-① dir.

    Called when the agent is saved, because that is the moment the spec (and the
    fact that every name is in the user's pool) is known and validated. Returns
    the names that resolved; a name that has since left the pool is skipped with
    a warning rather than failing the save — the agent simply ships without it.

    Kept separate from :func:`_enable_skill_for_agent` because the two tiers must
    stay structurally distinct: this directory is mounted read-only, so a skill
    that lands here cannot be removed by the per-agent enable/disable endpoint.
    Names no longer declared are pruned, so editing an agent's skill list is
    reflected on the next run.
    """
    wanted = {_safe_segment(name): name for name in skill_names}
    dest_parent = layout.agent_default_skills_root(user_id, agent_slug)
    dest_parent.mkdir(parents=True, exist_ok=True)

    resolved: list[str] = []
    for segment, name in wanted.items():
        dest = dest_parent / segment
        try:
            src = resolve_skill_path(user_id, name)
        except Exception:  # not in the pool any more — see the docstring
            logger.warning(
                "agent_default_skill_unresolved",
                "Declared default skill is not in the user's pool; skipping",
                user_id=user_id,
                agent_slug=agent_slug,
                skill_name=name,
            )
            continue
        # Re-copy rather than skip-if-exists: saving the agent is the sync point,
        # so the mounted copy should match the pool as of this save.
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(src, dest)
        resolved.append(name)

    # Prune anything the spec no longer declares.
    for existing in dest_parent.iterdir():
        if existing.is_dir() and existing.name not in wanted:
            shutil.rmtree(existing, ignore_errors=True)

    logger.info(
        "agent_default_skills_synced",
        "Synced a user agent's declared default skills from the pool",
        user_id=user_id,
        agent_slug=agent_slug,
        count=len(resolved),
    )
    return resolved


def list_user_skill_names(user_id: str) -> Iterable[str]:
    """Just the names — handy for callers that don't need full entries."""
    return [s.name for s in read_user_manifest(user_id).skills]
