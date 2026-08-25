"""Skill-registry DTOs: the global/per-user manifest rows, skill folder files,
and the create/detail payloads for custom skills."""
from typing import List, Literal
from pydantic import BaseModel, Field


class SkillManifest(BaseModel):
    """One entry in the central skills registry (``runtime/skill_registry/registry/``).

    ``content`` is the markdown body that follows the frontmatter — agents
    pull this in via the deepagents ``SkillsMiddleware`` when the user has
    enabled the skill for that (user, agent) pair.

    ``category`` is the parent folder under the global registry root. It
    surfaces in the UI as a small label next to the skill name so users can
    place a skill in context while searching.
    """

    name: str
    description: str = ""
    content: str = ""
    category: str = ""


class SkillManifestEntry(BaseModel):
    """One row in the on-disk manifest.json — global or per-user.

    ``source_path`` is relative to the skills_registry root the agents
    service joins it against. Globals: ``global/<category>/<name>``.
    Customs: ``users/<user_id>/custom/<name>`` (no category folder; custom
    skills are flat under each user's custom dir).

    ``category`` is the parent folder name in the global hierarchy — empty
    for custom skills.
    """

    name: str
    type: Literal["global", "custom"]
    description: str = ""
    source_path: str
    category: str = ""


class GlobalManifest(BaseModel):
    """The on-disk ``$SKILLS_REGISTRY_GLOBAL_ROOT/manifest.json`` schema."""

    version: int = 1
    skills: List[SkillManifestEntry] = Field(default_factory=list)


class UserManifest(BaseModel):
    """The on-disk per-user manifest schema at
    ``$SKILLS_REGISTRY_USERS_ROOT/<user_id>/manifest.json``."""

    version: int = 1
    skills: List[SkillManifestEntry] = Field(default_factory=list)


class SkillFile(BaseModel):
    """One file inside a skill folder.

    ``path`` is relative to the skill root and ``/``-separated (e.g.
    ``SKILL.md`` or ``references/api.md``). ``content`` is UTF-8 text when
    ``encoding == "utf-8"`` or standard base64 when ``encoding == "base64"``
    (used for binary assets like images). ``size`` is the decoded byte length —
    populated on read, ignored on create.
    """

    path: str
    content: str = ""
    encoding: Literal["utf-8", "base64"] = "utf-8"
    size: int = 0


class CustomSkillCreate(BaseModel):
    """Request body for ``POST /users/{user_id}/skills/custom``.

    A custom skill is a folder of files. Exactly one file must be named
    ``SKILL.md`` — its body is wrapped with canonical frontmatter assembled
    server-side from ``name`` + ``description`` so the agent reads a consistent
    SKILL.md regardless of how the skill was authored. Every other file is
    written verbatim (UTF-8 text or base64-decoded binary).
    """

    name: str
    description: str = ""
    files: List[SkillFile] = Field(default_factory=list)


class UserSkillDetail(BaseModel):
    """Returned by ``GET /users/{user_id}/skills/{name}`` — manifest row joined
    with the skill's file inventory.

    ``content`` is the parsed SKILL.md body (frontmatter stripped) kept as a
    convenience for a quick preview; ``files`` is the full on-disk inventory.
    """

    name: str
    type: Literal["global", "custom"]
    description: str = ""
    source_path: str
    category: str = ""
    content: str = ""
    files: List[SkillFile] = Field(default_factory=list)
