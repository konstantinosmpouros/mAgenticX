"""Skills registry DTOs: global catalog, user pool, skill files, custom-skill create."""
from typing import List, Literal
from pydantic import BaseModel, Field


class Skill(BaseModel):
    """One entry in the global skills catalog.

    Mirrors :class:`agents.schemas.SkillManifest`. ``category`` is the
    parent folder under the global registry root, surfaced as a small label
    next to the skill name in the UI.
    """

    name: str
    description: str = ""
    content: str = ""
    category: str = ""


class UserSkill(BaseModel):
    """One entry in a user's personal skill pool (manifest row, no content).

    Mirrors :class:`agents.schemas.SkillManifestEntry`. ``type`` distinguishes
    references to globals (``"global"``) from user-owned custom skills
    (``"custom"``). ``category`` is the parent folder in the global
    hierarchy — empty string for custom skills.
    """

    name: str
    type: Literal["global", "custom"]
    description: str = ""
    source_path: str
    category: str = ""


class SkillFile(BaseModel):
    """One file inside a skill folder.

    ``path`` is relative to the skill root (``/``-separated); ``content`` is
    UTF-8 text or base64 per ``encoding``. ``size`` is the decoded byte length
    (populated on read, ignored on create). Mirrors :class:`agents.schemas.SkillFile`.
    """

    path: str
    content: str = ""
    encoding: Literal["utf-8", "base64"] = "utf-8"
    size: int = 0


class UserSkillDetail(BaseModel):
    """A user-pool entry joined with its file inventory — returned by
    ``GET /v1/users/{user_id}/skills/{name}``.

    ``content`` is the parsed SKILL.md body (quick preview); ``files`` is the
    full on-disk inventory."""

    name: str
    type: Literal["global", "custom"]
    description: str = ""
    source_path: str
    category: str = ""
    content: str = ""
    files: List[SkillFile] = Field(default_factory=list)


class CustomSkillCreateRequest(BaseModel):
    """Request body for ``POST /v1/users/{user_id}/skills/custom``.

    A custom skill is a folder of files; one must be ``SKILL.md``. The list is
    bounded here as cheap DoS protection — the agents service enforces the
    authoritative per-file/total byte caps when it decodes and writes."""

    name: str
    description: str = ""
    files: List[SkillFile] = Field(default_factory=list, max_length=30)
