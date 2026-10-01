"""Skills registry DTOs: a user's pool, skill files, custom-skill create, and the
search over the remote skill catalogue (plan 30)."""
from typing import List, Literal, Optional
from pydantic import BaseModel, Field

#: Mirrors the agents service. ``remote`` is a skill added from an allowlisted
#: remote source, pinned to the version the user added. ``global`` is legacy —
#: a reference into the bundled catalogue plan 30 deleted, still readable.
PoolSkillType = Literal["global", "custom", "remote"]


class RemoteProvenance(BaseModel):
    """Where a remote skill came from. Mirrors :class:`agents.schemas.RemoteProvenance`.

    ``commit`` is the upstream commit, or the artifact's ``sha256:`` digest for
    a publisher-hosted skill; ``licence`` is ``None`` for those.
    """

    source_id: str
    source_label: str
    commit: Optional[str] = None
    licence: Optional[str] = None
    upstream_url: Optional[str] = None


class UserSkill(BaseModel):
    """One entry in a user's personal skill pool (manifest row, no content).

    Mirrors :class:`agents.schemas.SkillManifestEntry`. ``type`` distinguishes
    references to globals (``"global"``) from user-owned custom skills
    (``"custom"``) and remote additions (``"remote"``, which carry
    ``provenance``). ``category`` is the parent folder in the global
    hierarchy — empty string for custom skills.
    """

    name: str
    type: PoolSkillType
    description: str = ""
    source_path: str
    category: str = ""
    provenance: Optional[RemoteProvenance] = None


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
    type: PoolSkillType
    description: str = ""
    source_path: str
    category: str = ""
    content: str = ""
    files: List[SkillFile] = Field(default_factory=list)
    provenance: Optional[RemoteProvenance] = None


class CustomSkillCreateRequest(BaseModel):
    """Request body for ``POST /v1/users/{user_id}/skills/custom``.

    A custom skill is a folder of files; one must be ``SKILL.md``. The list is
    bounded here as cheap DoS protection — the agents service enforces the
    authoritative per-file/total byte caps when it decodes and writes."""

    name: str
    description: str = ""
    files: List[SkillFile] = Field(default_factory=list, max_length=30)


class CatalogueSkill(BaseModel):
    """One catalogue search result. Mirrors :class:`agents.schemas.CatalogueSkill`.

    Added by ``(source_id, skill_id)``; ``commit`` is the upstream version an
    Add would pin.
    """

    source_id: str
    source_label: str
    skill_id: str
    name: str
    description: str = ""
    category: str = ""
    licence: Optional[str] = None
    commit: Optional[str] = None
    upstream_url: Optional[str] = None


class CatalogueSearchPage(BaseModel):
    """A page of catalogue results — the response of ``GET /v1/skills/catalogue``.

    ``total`` counts every match, not just this page; ``remote_enabled`` says
    whether remote results can be added on this deployment at all.
    """

    results: List[CatalogueSkill] = Field(default_factory=list)
    total: int = 0
    limit: int = 10
    offset: int = 0
    remote_enabled: bool = False
