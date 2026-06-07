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

from observability import get_logger
from schemas import SkillManifest

logger = get_logger(__name__)

# Resolved relative to this file: src/agents/utils/skills.py → src/agents/skills_registry/
_SKILLS_REGISTRY_DIR = Path(__file__).resolve().parent.parent / "skills_registry"


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
    if not _SKILLS_REGISTRY_DIR.is_dir():
        logger.warning(
            "skills_registry_missing",
            "Skills registry directory does not exist",
            path=str(_SKILLS_REGISTRY_DIR),
        )
        return []

    skills: List[SkillManifest] = []
    for child in sorted(_SKILLS_REGISTRY_DIR.iterdir()):
        if not child.is_dir():
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            continue
        manifest = _parse_skill_md(skill_md)
        if manifest is not None:
            skills.append(manifest)
    return skills
