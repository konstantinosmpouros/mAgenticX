"""Skills registry — read-only catalogue of available SKILL.md files.

The registry lives in the image at ``src/agents/skills_registry/<name>/SKILL.md``
and is the single source of truth for "what skills exist." Per-user enabled
skills (Phase 2+) are tracked as directories under the per-user filesystem;
the registry only describes *what is available to enable*.

SKILL.md frontmatter contract (parsed loosely; only ``name`` and ``description``
are extracted, anything else is ignored):

    ---
    name: <skill-id>
    description: <one-line summary>
    ---

    <markdown body>
"""
from __future__ import annotations

from pathlib import Path
from typing import List

from core.settings import settings
from observability import get_logger
from runtime.filesystem import (
    disable_skill as _disable_skill_fs,
    enable_skill as _enable_skill_fs,
    ensure_user_agent_filesystem,
    is_registry_skill,
    list_enabled_skills as _list_enabled_skills_fs,
)
from schemas import SkillManifest

logger = get_logger(__name__)


def _registry_dir() -> Path:
    """Indirected through settings so the path is overridable in tests."""
    return settings.filesystem.skills_registry_root


def _parse_skill_md(path: Path) -> SkillManifest | None:
    """Parse a SKILL.md file into a :class:`SkillManifest`.

    Returns None if the file is malformed (missing frontmatter, missing
    required keys). The directory name is used as the canonical ``name``
    if the frontmatter doesn't supply one — but a well-formed SKILL.md
    should always carry ``name:`` matching its directory.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("skill_read_failed", "Could not read SKILL.md", path=str(path))
        return None

    name = path.parent.name
    description = ""
    body = raw

    if raw.startswith("---\n"):
        end = raw.find("\n---\n", 4)
        if end != -1:
            frontmatter = raw[4:end]
            body = raw[end + 5 :].lstrip("\n")
            for line in frontmatter.splitlines():
                if ":" not in line:
                    continue
                key, _, value = line.partition(":")
                key = key.strip().lower()
                value = value.strip().strip("\"'")
                if key == "name" and value:
                    name = value
                elif key == "description":
                    description = value

    return SkillManifest(name=name, description=description, content=body)


def list_registry_skills() -> List[SkillManifest]:
    """Return every skill in the registry, sorted alphabetically by name.

    Cheap enough to call on every request — the registry holds a handful of
    static files at most. The bridge caches the result in Redis with a short
    TTL so most calls don't hit this function anyway.
    """
    registry_dir = _registry_dir()
    if not registry_dir.is_dir():
        logger.warning(
            "skills_registry_missing",
            "Skills registry directory does not exist",
            path=str(registry_dir),
        )
        return []

    skills: List[SkillManifest] = []
    for child in sorted(registry_dir.iterdir()):
        if not child.is_dir():
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            continue
        manifest = _parse_skill_md(skill_md)
        if manifest is not None:
            skills.append(manifest)
    return skills


# ---------------------------------------------------------------------------
# Per-(user, agent) selection helpers
# ---------------------------------------------------------------------------
# These thin wrappers re-export the filesystem-level primitives so the FastAPI
# handlers in ``main.py`` can stay imports-free of runtime internals. The
# provisioner is the single writer of the on-disk skill set after first run.


def list_user_agent_skills(user_id: str, agent_slug: str) -> List[str]:
    """Return enabled skill names for a (user, agent) pair, sorted."""
    ensure_user_agent_filesystem(user_id=user_id, agent_slug=agent_slug)
    return _list_enabled_skills_fs(user_id, agent_slug)


def enable_user_agent_skill(*, user_id: str, agent_slug: str, skill_name: str) -> None:
    """Copy the named registry skill into the user-agent's skills directory.

    Raises ``FileNotFoundError`` if the skill is not in the registry — the
    HTTP layer maps that to a 404 response.
    """
    if not is_registry_skill(skill_name):
        raise FileNotFoundError(f"Skill not in registry: {skill_name}")
    ensure_user_agent_filesystem(user_id=user_id, agent_slug=agent_slug)
    _enable_skill_fs(user_id=user_id, agent_slug=agent_slug, skill_name=skill_name)


def disable_user_agent_skill(*, user_id: str, agent_slug: str, skill_name: str) -> None:
    """Remove the named skill from the user-agent's skills directory.

    Idempotent: no error when the skill isn't enabled.
    """
    ensure_user_agent_filesystem(user_id=user_id, agent_slug=agent_slug)
    _disable_skill_fs(user_id=user_id, agent_slug=agent_slug, skill_name=skill_name)
