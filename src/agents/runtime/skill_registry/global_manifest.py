"""Global skills registry manifest — generation + in-memory cache.

The global manifest is the bridge's index for ``GET /v1/skills`` and the
agents service's authoritative answer to "does this skill exist in the
global pool?". It's regenerated on every agents-service boot inside the
FastAPI lifespan, after ``seed_global_registry()`` runs.

Disk layout::

    $SKILLS_REGISTRY_GLOBAL_ROOT/
        manifest.json                       ← list of SkillManifestEntry rows
        <category>/                         ← e.g. "research", "frontend"
            <skill_name>/SKILL.md           ← the actual skill content

Skills always live two levels deep — ``<category>/<skill_name>``. A SKILL.md
sitting directly under the global root or under a category root (with no
intervening skill folder) is skipped with a warning; this keeps the
hierarchy explicit and lets the UI surface a category label next to every
skill.

In-memory cache::

    _MANIFEST_CACHE: GlobalManifest | None

`rebuild_global_manifest()` rescans the directory + rewrites manifest.json
+ replaces the cache. `get_global_manifest()` returns the cache or a fresh
rebuild if absent.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from core.settings import settings
from observability import get_logger
from schemas import SkillManifestEntry, GlobalManifest

logger = get_logger(__name__)

_MANIFEST_FILENAME = "manifest.json"
_MANIFEST_CACHE: GlobalManifest | None = None


def _manifest_path() -> Path:
    return settings.filesystem.skills_registry_global_root / _MANIFEST_FILENAME


def _parse_frontmatter(skill_md: Path) -> tuple[str, str]:
    """Return ``(name, description)`` from a SKILL.md frontmatter.

    Falls back to the directory name if ``name:`` is absent. Mirrors the
    loose parser in ``utils.skills._parse_skill_md`` — only ``name`` and
    ``description`` are extracted; everything else is ignored.
    """
    name = skill_md.parent.name
    description = ""
    try:
        raw = skill_md.read_text(encoding="utf-8")
    except OSError:
        logger.warning(
            "skill_md_read_failed",
            "Could not read SKILL.md for manifest",
            path=str(skill_md),
        )
        return name, description

    if not raw.startswith("---\n"):
        return name, description

    end = raw.find("\n---\n", 4)
    if end == -1:
        return name, description

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
    return name, description


def _scan_global_registry() -> list[SkillManifestEntry]:
    root = settings.filesystem.skills_registry_global_root
    if not root.is_dir():
        logger.warning(
            "skills_global_root_missing",
            "Global registry root does not exist",
            path=str(root),
        )
        return []

    entries: list[SkillManifestEntry] = []
    for category_dir in sorted(root.iterdir()):
        # Skip the manifest.json itself and any other top-level files.
        if not category_dir.is_dir():
            continue
        # A SKILL.md sitting directly inside a category dir (with no
        # intervening skill folder) is orphan state from a pre-category
        # layout. Log it but DO NOT skip the category — legitimate
        # ``<category>/<skill>/SKILL.md`` siblings should still be picked up.
        if (category_dir / "SKILL.md").is_file():
            logger.warning(
                "skills_category_orphan_skill_md",
                "Category dir contains a stray SKILL.md at its root — "
                "ignored. Place skills as <category>/<skill>/SKILL.md.",
                path=str(category_dir / "SKILL.md"),
            )
        category = category_dir.name
        for skill_dir in sorted(category_dir.iterdir()):
            if not skill_dir.is_dir():
                continue
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.is_file():
                continue
            name, description = _parse_frontmatter(skill_md)
            entries.append(
                SkillManifestEntry(
                    name=name,
                    type="global",
                    description=description,
                    source_path=f"global/{category}/{skill_dir.name}",
                    category=category,
                )
            )
    return entries


def _write_manifest_atomic(manifest: GlobalManifest) -> None:
    """Write manifest.json via tmp + os.replace (atomic).

    Atomic write protects against torn reads if the bridge or another agent
    process is reading the manifest while we rewrite it.
    """
    target = _manifest_path()
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


def rebuild_global_manifest() -> GlobalManifest:
    """Rescan the global registry directory, rewrite manifest.json, refresh cache."""
    global _MANIFEST_CACHE
    entries = _scan_global_registry()
    manifest = GlobalManifest(version=1, skills=entries)
    _write_manifest_atomic(manifest)
    _MANIFEST_CACHE = manifest
    logger.info(
        "skills_global_manifest_rebuilt",
        "Global skills manifest rebuilt",
        skill_count=len(entries),
        path=str(_manifest_path()),
    )
    return manifest


def get_global_manifest() -> GlobalManifest:
    """Return the cached manifest, rebuilding if the cache is empty."""
    if _MANIFEST_CACHE is None:
        return rebuild_global_manifest()
    return _MANIFEST_CACHE


def is_global_skill(skill_name: str) -> bool:
    """True iff ``skill_name`` is in the cached global manifest."""
    return any(entry.name == skill_name for entry in get_global_manifest().skills)
