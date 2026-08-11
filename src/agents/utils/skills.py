"""Skills registry helpers — read-side wrappers around the runtime modules.

The global registry lives on a mounted volume at
``$SKILLS_REGISTRY_GLOBAL_ROOT`` and is indexed by ``manifest.json``
regenerated on agents-service boot (see ``runtime.skill_registry``). This
module exposes:

- ``list_registry_skills()`` — the catalogue served by ``GET /skills`` to
  the bridge. Reads the cached global manifest, joins each entry with its
  SKILL.md body, returns ``list[SkillManifest]``.
- Per-(user, agent) selection wrappers re-exporting the filesystem
  primitives so the FastAPI handlers stay imports-free of runtime internals.

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
from runtime.filesystem import layout
from runtime.filesystem import (
    disable_skill as _disable_skill_fs,
    ensure_user_agent_filesystem,
    list_enabled_skills as _list_enabled_skills_fs,
)
from runtime.skill_registry import (
    assign_user_skill_to_agent as _assign_user_skill_to_agent,
    get_global_manifest,
)
from schemas import SkillManifest

logger = get_logger(__name__)


def _read_skill_body_from_source_path(source_path: str) -> str:
    """Return the markdown body following the frontmatter, or empty string.

    ``source_path`` is the manifest entry's relative path under the
    skills_registry root (e.g. ``global/<category>/<name>``). The "global/"
    prefix is stripped and the rest joined under the global volume root.
    """
    parts = source_path.split("/")
    if len(parts) < 2 or parts[0] != "global":
        logger.warning(
            "skill_body_unexpected_source_path",
            "Unexpected source_path for global skill body lookup",
            source_path=source_path,
        )
        return ""
    skill_md = layout.global_skills_root()
    for segment in parts[1:]:
        skill_md = skill_md / segment
    skill_md = skill_md / "SKILL.md"
    try:
        raw = skill_md.read_text(encoding="utf-8")
    except OSError:
        logger.warning(
            "skill_body_read_failed",
            "Could not read SKILL.md body",
            path=str(skill_md),
        )
        return ""

    if not raw.startswith("---\n"):
        return raw
    end = raw.find("\n---\n", 4)
    if end == -1:
        return raw
    return raw[end + 5 :].lstrip("\n")


def list_registry_skills() -> List[SkillManifest]:
    """Return every global skill with frontmatter + content, alphabetical.

    Reads from the cached ``GlobalManifest`` so this is O(N) string joins —
    no directory scan per call.
    """
    manifest = get_global_manifest()
    skills: List[SkillManifest] = []
    for entry in manifest.skills:
        skills.append(
            SkillManifest(
                name=entry.name,
                description=entry.description,
                category=entry.category,
                content=_read_skill_body_from_source_path(entry.source_path),
            )
        )
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
    """Copy a user-pool skill into the user-agent's skills directory.

    Source is resolved via the user's manifest (global ref → global volume;
    custom entry → user volume). Raises ``FileNotFoundError`` if the skill
    is not in the user's pool — the HTTP layer maps to 404.
    """
    ensure_user_agent_filesystem(user_id=user_id, agent_slug=agent_slug)
    _assign_user_skill_to_agent(
        user_id=user_id,
        agent_slug=agent_slug,
        skill_name=skill_name,
    )


def disable_user_agent_skill(*, user_id: str, agent_slug: str, skill_name: str) -> None:
    """Remove the named skill from the user-agent's skills directory.

    Idempotent: no error when the skill isn't enabled.
    """
    ensure_user_agent_filesystem(user_id=user_id, agent_slug=agent_slug)
    _disable_skill_fs(user_id=user_id, agent_slug=agent_slug, skill_name=skill_name)
