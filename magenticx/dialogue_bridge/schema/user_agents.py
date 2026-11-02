"""User-authored agent DTOs (proxied to the agents service)."""
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field

from schema.base import UTCDateTime


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


class CustomAgentIssue(BaseModel):
    """One problem with a definition, addressed to the field it is about.

    ``path`` is a dotted path into the spec (``subagents.0.name``) so the
    builder can highlight the exact field; a warning does not make the
    definition invalid.
    """
    path: str = ""
    message: str
    severity: Literal["error", "warning"] = "error"


class CustomAgentValidation(BaseModel):
    """Dry-run result for the builder: would this definition be accepted?

    ``errors`` is the older flat list, kept for clients that predate ``issues``.
    """
    valid: bool
    errors: list[str] = Field(default_factory=list)
    issues: list[CustomAgentIssue] = Field(default_factory=list)


class CustomAgentImportResult(CustomAgentValidation):
    """An imported ``agent.yaml`` (+ files) checked by the agents service.

    Nothing is saved. ``spec`` is the parsed definition (``None`` when the YAML
    could not be read) and ``files`` what the create call should send — inline
    prompts come back as files, so it can differ from what was uploaded.
    """
    spec: dict | None = None
    files: list[AgentFile] = Field(default_factory=list)


class RenderedAgentYaml(BaseModel):
    """A draft definition as ``agent.yaml`` text, for the builder's YAML view.

    Rendered by the agents service from whatever the builder sends — saved or
    not, valid or not — so the view works before the agent exists.
    """
    yaml: str


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


class CustomAgentVersion(BaseModel):
    """One kept version of a user-authored agent, as the History list shows it.

    The agents service keeps a whole copy of the agent on every save (bounded
    there, oldest pruned first), so the list is short and needs no paging.
    ``kind`` says why the version exists — ``created``, ``saved``, ``restored``
    (from ``restoredFrom``), or ``baseline``, the agent as it stood before
    history began — and ``changes`` names the parts that save touched
    (``details``, ``instructions``, ``model``, ``tools``, …). ``basedOn`` is
    the version the save was made on top of; ``current`` marks the version the
    agent is now (a restore moves it back rather than adding a version).

    Read from the agents service's snake_case body (``validation_alias``) and
    sent to the browser camelCase (the field names), like ``AgentPublic``.
    """
    model_config = ConfigDict(populate_by_name=True)

    versionNo: int = Field(..., ge=1, validation_alias="version_no")
    kind: Literal["created", "saved", "restored", "baseline"]
    changes: list[str] = Field(default_factory=list)
    restoredFrom: Optional[int] = Field(None, ge=1, validation_alias="restored_from")
    basedOn: Optional[int] = Field(None, ge=1, validation_alias="based_on")
    current: bool = False
    createdAt: UTCDateTime = Field(..., validation_alias="created_at")


class CustomAgentVersionDetail(CustomAgentVersion):
    """One kept version with the whole definition it holds, for a diff or a restore preview."""
    spec: dict = Field(default_factory=dict)
    files: list[AgentFile] = Field(default_factory=list)
