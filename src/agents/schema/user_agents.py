"""User-authored agent DTOs: the agent-folder file shape and the write /
validate / list / detail payloads for the builder UI."""
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
    into :class:`~runtime.abstractions.agent_spec.AgentSpec`, so the wire contract
    and the runtime contract cannot drift. ``files`` carries the prompt files the
    spec references (``AGENT.md``, ``subagents/*.md``); every path the spec points
    at must be present here.
    """

    spec: Dict[str, Any] = Field(default_factory=dict)
    files: List[AgentFile] = Field(default_factory=list)


class CustomAgentValidation(BaseModel):
    """Dry-run result: whether a spec would be accepted, and why not."""

    valid: bool
    errors: List[str] = Field(default_factory=list)


class UserAgentSummary(BaseModel):
    """A user-authored agent as the listing sees it (mirrors the registry manifest)."""

    id: str
    slug: str
    name: str
    version: str = ""
    type: str = "deep agent"
    description: str = ""
    icon: str = ""


class UserAgentDetail(UserAgentSummary):
    """One user-authored agent with its full definition, for editing."""

    spec: Dict[str, Any] = Field(default_factory=dict)
    files: List[AgentFile] = Field(default_factory=list)
