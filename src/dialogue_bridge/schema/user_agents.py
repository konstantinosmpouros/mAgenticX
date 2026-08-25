"""User-authored agent DTOs (proxied to the agents service)."""
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field


class AgentFile(BaseModel):
    """One file inside a user-authored agent folder (a prompt, not a payload)."""
    model_config = ConfigDict(populate_by_name=True)

    path: str
    content: str = ""
    encoding: Literal["utf-8", "base64"] = "utf-8"
    size: Optional[int] = None


class CustomAgentWrite(BaseModel):
    """Create/update body for a user-authored agent.

    ``spec`` is the ``agent.yaml`` document as a mapping — forwarded verbatim to
    the agents service, which validates it against the same ``AgentSpec`` the
    runtime uses, so the wire contract cannot drift from the runtime contract.
    ``files`` carries the prompt files the spec references.
    """
    model_config = ConfigDict(populate_by_name=True)

    spec: dict = Field(default_factory=dict)
    files: list[AgentFile] = Field(default_factory=list)


class CustomAgentValidation(BaseModel):
    """Dry-run result for the builder: would this definition be accepted?"""
    valid: bool
    errors: list[str] = Field(default_factory=list)


class CustomAgentDetail(BaseModel):
    """A user-authored agent's full definition, for the edit view.

    ``id`` is the **catalog** id (the agents row), not the spec's own id, so the
    frontend can key it exactly like any other agent.
    """
    model_config = ConfigDict(populate_by_name=True)

    id: str
    slug: str
    name: str
    description: str = ""
    icon: str = ""
    version: Optional[str] = None
    type: str = "deep agent"
    spec: dict = Field(default_factory=dict)
    files: list[AgentFile] = Field(default_factory=list)
