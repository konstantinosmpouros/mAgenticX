"""Bootstrap copy from the in-image seed dir into the global registry volume.

The image ships the admin-curated skill catalog at
``/opt/skills_registry_seed/`` (copied in by the Dockerfile from
``runtime/skill_registry/registry/``). At boot, we copy that into the mounted
``$SKILLS_REGISTRY_GLOBAL_ROOT`` volume using ``cp -rn`` semantics —
existing destination files are never overwritten. This handles:

- First-run on an empty volume: the catalog appears.
- Image upgrade that adds a new skill: the new dir gets copied in alongside
  existing folders that may have been modified out-of-band.

After this runs, ``rebuild_global_manifest()`` indexes the volume content
into ``$SKILLS_REGISTRY_GLOBAL_ROOT/manifest.json``.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from core.settings import settings
from observability import get_logger

logger = get_logger(__name__)

# Where the Dockerfile drops a copy of runtime/skill_registry/registry/ at build
# time. Override via env for tests / local-dev. Absence of the seed dir is
# logged and skipped — not fatal (the volume may already be populated, e.g.
# in production after the first deploy).
_SEED_DIR_ENV = "SKILLS_REGISTRY_SEED_DIR"
_DEFAULT_SEED_DIR = Path("/opt/skills_registry_seed")


def _seed_dir() -> Path:
    override = os.getenv(_SEED_DIR_ENV)
    return Path(override) if override else _DEFAULT_SEED_DIR


def seed_global_registry() -> None:
    """Idempotent copy from the seed dir into the global registry volume.

    The seed and target both use the two-level ``<category>/<skill>``
    hierarchy. We walk categories at the top level, then skills inside each
    category, copying any skill folder that doesn't yet exist on the volume.

    - Missing category folder on target → mkdir.
    - Missing skill folder under a category → ``copytree`` from seed.
    - Existing skill folder → skipped (admin's out-of-band edits win).
    - ``manifest.json`` at the volume root is never touched here — that's
      the manifest module's job after this returns.
    """
    seed = _seed_dir()
    target = settings.filesystem.skills_registry_global_root

    if not seed.is_dir():
        logger.info(
            "skills_seed_dir_missing",
            "Seed dir absent; skipping global registry seed",
            seed_dir=str(seed),
            target=str(target),
        )
        return

    target.mkdir(parents=True, exist_ok=True)

    copied: list[str] = []
    skipped: list[str] = []
    for category_dir in sorted(seed.iterdir()):
        if not category_dir.is_dir():
            continue
        target_category = target / category_dir.name
        target_category.mkdir(parents=True, exist_ok=True)
        for skill_dir in sorted(category_dir.iterdir()):
            if not skill_dir.is_dir():
                continue
            dest = target_category / skill_dir.name
            qualified = f"{category_dir.name}/{skill_dir.name}"
            if dest.exists():
                skipped.append(qualified)
                continue
            try:
                shutil.copytree(skill_dir, dest)
                copied.append(qualified)
            except OSError:
                logger.warning(
                    "skill_seed_copy_failed",
                    "Failed to seed skill directory into global registry",
                    exc_info=True,
                    skill=qualified,
                    src=str(skill_dir),
                    dest=str(dest),
                )

    logger.info(
        "skills_global_seed_completed",
        "Seeded global skills registry from image",
        copied=copied,
        skipped=skipped,
        target=str(target),
    )
