"""User-authored agent DTOs: the agent-folder file shape and the write /
validate / list / detail payloads for the builder UI."""
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


class AgentFile(BaseModel):
    """One file inside a user-authored agent folder.

    Deliberately separate from ``SkillFile`` despite the identical shape: an
    agent folder holds only prompts and config, so its allowlist is far narrower
    than a skill's (which may carry scripts and binary assets).
    """

    path: str
    content: str = ""
    encoding: Literal["utf-8", "base64"] = "utf-8"
    size: Optional[int] = None


class CustomAgentWrite(BaseModel):
    """Request body for creating/updating a user-authored agent.

    ``spec`` is the ``agent.yaml`` document as a mapping — validated straight
    into :class:`~harness.abstractions.agent_spec.AgentSpec`, so the wire contract
    and the runtime contract cannot drift. ``files`` carries the prompt files the
    spec references (``AGENT.md``, ``subagents/*.md``); every path the spec points
    at must be present here.
    """

    spec: Dict[str, Any] = Field(default_factory=dict)
    files: List[AgentFile] = Field(default_factory=list)


class AgentIssue(BaseModel):
    """One problem with a definition, pinned to where it is.

    ``path`` points into the spec the builder sent, dotted with list indices
    (``subagents.0.subagents.1.name``), or names a file as ``files[AGENT.md]``;
    empty for the definition as a whole. A ``warning`` never blocks a save (an
    MCP tool that could not be checked because the gateway is down).
    """

    path: str = ""
    message: str
    severity: Literal["error", "warning"] = "error"


class CustomAgentValidation(BaseModel):
    """Dry-run result: whether a spec would be accepted, and why not.

    ``errors`` is the error messages alone, kept for callers that predate
    ``issues``.
    """

    valid: bool
    errors: List[str] = Field(default_factory=list)
    issues: List[AgentIssue] = Field(default_factory=list)


class CustomAgentImport(BaseModel):
    """An ``agent.yaml`` as text, with the files its prompts point at.

    ``slug`` names the agent the YAML is to replace ("Replace from YAML…" on an
    existing agent): a YAML without a ``slug:`` takes it, and one with another
    slug is refused, because a slug never changes.
    """

    yaml: str
    files: List[AgentFile] = Field(default_factory=list)
    slug: Optional[str] = None


class CustomAgentImportResult(CustomAgentValidation):
    """An import, parsed and checked but never saved.

    ``spec`` is what the YAML became (inline prompts moved into files, missing
    ``id``/``version``/``type`` filled in) — set whenever the YAML parsed, even
    when it is not valid, so the builder can open it in the form to fix.
    ``files`` is the input files plus any generated prompt files.
    """

    spec: Optional[Dict[str, Any]] = None
    files: List[AgentFile] = Field(default_factory=list)


class RenderedAgentYaml(BaseModel):
    """A draft definition as ``agent.yaml`` text — the builder's YAML view."""

    yaml: str


class UserAgentSummary(BaseModel):
    """A user-authored agent as the listing sees it (mirrors the registry manifest)."""

    id: str
    slug: str
    name: str
    version: str = ""
    type: str = "deep agent"
    description: str = ""
    icon: str = ""
    #: The main model, and how much the agent carries — for the gallery cards.
    model: str = ""
    tool_count: int = 0
    skill_count: int = 0
    #: Every sub-agent at every depth.
    subagent_count: int = 0


class UserAgentDetail(UserAgentSummary):
    """One user-authored agent with its full definition, for editing."""

    spec: Dict[str, Any] = Field(default_factory=dict)
    files: List[AgentFile] = Field(default_factory=list)


class AgentVersionSummary(BaseModel):
    """One kept version of a user-authored agent, as the History list shows it.

    ``kind`` says why it exists: ``created``, ``saved``, ``restored`` (from
    ``restored_from``; only versions kept before a restore stopped adding
    one), or ``baseline`` — the agent as it stood before history
    began. ``changes`` names the parts the save touched, against the version
    it was saved on top of (``details``, ``instructions``, ``model``, ``tools``, ``skills``,
    ``team``, ``files``, ``settings``). ``based_on`` is the version the save
    was made on top of, and ``current`` marks the version the agent is now —
    a restore moves it back instead of adding a version.
    """

    version_no: int
    kind: Literal["created", "saved", "restored", "baseline"]
    changes: List[str] = Field(default_factory=list)
    restored_from: Optional[int] = None
    based_on: Optional[int] = None
    current: bool = False
    created_at: datetime


class AgentVersionDetail(AgentVersionSummary):
    """One version with the whole definition it kept, for a diff or a restore."""

    spec: Dict[str, Any] = Field(default_factory=dict)
    files: List[AgentFile] = Field(default_factory=list)
