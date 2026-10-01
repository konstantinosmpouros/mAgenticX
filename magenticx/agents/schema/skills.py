"""Skill-registry DTOs: a user's pool rows, skill folder files, the
create/detail payloads for custom skills, and the remote catalogue search (plan 30)."""
from typing import List, Literal, Optional
from pydantic import BaseModel, Field

#: The kinds of pool entry. ``remote`` came from an allowlisted remote source
#: and resolves into a shared, pinned copy. ``global`` is legacy: a reference
#: into the bundled catalogue that plan 30 removed, still readable from the
#: volume until those entries are pruned — nothing can create one any more.
PoolSkillType = Literal["global", "custom", "remote"]


class SkillManifestEntry(BaseModel):
    """One entry in a user's skill pool.

    ``source_path`` is a display path only: ``users/<user_id>/custom/<name>``
    for a custom skill, ``remote/<source>/<name>@<commit>`` for a remote one,
    ``global/<category>/<name>`` for a legacy catalogue reference.

    ``category`` comes from the remote source's index, when it has one.

    ``origin`` records who authored the skill. It defaults to ``"user"`` so every
    manifest written before agent authoring existed deserialises unchanged and
    reads as user-authored — which is true. The version stays 1: nothing about
    the addition is breaking, and bumping it would imply a migration branch that
    does not exist.
    """

    name: str
    type: PoolSkillType
    description: str = ""
    source_path: str
    category: str = ""
    origin: Literal["user", "agent"] = "user"
    #: Slug of the agent that authored this skill; None for user-authored ones.
    created_by_agent: str | None = None
    #: ISO-8601 UTC timestamp of authoring; None for entries predating provenance.
    created_at: str | None = None
    #: Remote entries only: where it came from, at which version, under which
    #: licence — shown on the pool card so the user can see what they hold.
    provenance: Optional["RemoteProvenance"] = None


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
    type: PoolSkillType
    description: str = ""
    source_path: str
    category: str = ""
    content: str = ""
    files: List[SkillFile] = Field(default_factory=list)
    provenance: Optional["RemoteProvenance"] = None


class RemoteProvenance(BaseModel):
    """Where a remote skill came from, as the user was shown it when adding.

    ``commit`` is the upstream commit for a GitHub source, or the artifact's
    ``sha256:`` digest for a ``.well-known`` one. ``licence`` is ``None`` for a
    publisher-distributed skill, which carries no licence of its own.
    """

    source_id: str
    source_label: str
    commit: Optional[str] = None
    licence: Optional[str] = None
    upstream_url: Optional[str] = None


class CatalogueSkill(BaseModel):
    """One search result: a remote skill that passed every gate."""

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
    """A page of catalogue search results.

    ``total`` counts every match, not just this page. ``remote_enabled`` tells
    the UI whether remote results can be added at all on this deployment.
    """

    results: List[CatalogueSkill] = Field(default_factory=list)
    total: int = 0
    limit: int = 10
    offset: int = 0
    remote_enabled: bool = False


class RemoteSourceStatus(BaseModel):
    """One allowlisted source and what its last sync recorded — the ops view."""

    source_id: str
    label: str
    kind: str
    source_ref: Optional[str] = None
    synced_at: Optional[str] = None
    last_error: Optional[str] = None
    skill_count: int = 0
    admitted_count: int = 0


SkillManifestEntry.model_rebuild()
UserSkillDetail.model_rebuild()
