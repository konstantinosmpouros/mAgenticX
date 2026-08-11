"""Seed built-in declarative agents from the image into the global volume.

The image ships built-in agent definitions at ``/opt/agents_seed/`` (copied by
the Dockerfile from ``src/agents/agents_seed/``). At boot we copy each agent
folder into ``<global_root>/agents/`` with ``cp -rn`` semantics — existing
folders on the volume win, so an admin's out-of-band edit to a built-in agent
persists across restarts, while a brand-new built-in appears on upgrade.

Mirror of ``runtime.skill_registry.seed_global_registry`` but one level deep
(agents are ``agents/<slug>/``, not ``<category>/<skill>/``). After this runs,
``utils.agents.refresh_registry()`` re-scans the volume so the built-ins join
``AGENT_REGISTRY`` (they are invisible at import time, before the seed).
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from core.settings import settings
from observability import get_logger

logger = get_logger(__name__)

_SEED_DIR_ENV = "AGENTS_SEED_DIR"
_DEFAULT_SEED_DIR = Path("/opt/agents_seed")


def _seed_dir() -> Path:
    override = os.getenv(_SEED_DIR_ENV)
    return Path(override) if override else _DEFAULT_SEED_DIR


def seed_global_agents() -> None:
    """Idempotent copy of built-in agent folders into ``<global_root>/agents/``.

    - Missing agent folder on target → ``copytree`` from the seed.
    - Existing agent folder → skipped (admin edits win).
    - Absent seed dir → logged and skipped (not fatal; the volume may already
      be populated).
    """
    seed = _seed_dir()
    target = settings.filesystem.global_root / "agents"

    if not seed.is_dir():
        logger.info(
            "agents_seed_dir_missing",
            "Seed dir absent; skipping global agents seed",
            seed_dir=str(seed),
            target=str(target),
        )
        return

    target.mkdir(parents=True, exist_ok=True)

    copied: list[str] = []
    skipped: list[str] = []
    for agent_dir in sorted(seed.iterdir()):
        if not agent_dir.is_dir():
            continue
        dest = target / agent_dir.name
        if dest.exists():
            skipped.append(agent_dir.name)
            continue
        try:
            shutil.copytree(agent_dir, dest)
            copied.append(agent_dir.name)
        except OSError:
            logger.warning(
                "agent_seed_copy_failed",
                "Failed to seed agent directory into the global volume",
                exc_info=True,
                agent=agent_dir.name,
                src=str(agent_dir),
                dest=str(dest),
            )

    logger.info(
        "agents_global_seed_completed",
        "Seeded global agents from image",
        copied=copied,
        skipped=skipped,
        target=str(target),
    )
