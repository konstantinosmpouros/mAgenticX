"""Agent + MCP tool catalog DTOs."""
from typing import Literal, Optional
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from schema.base import UTCDateTime


class AgentFull(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    slug: str
    name: str
    description: str
    icon: str
    version: Optional[str] = None
    type: str = "langgraph agent"
    is_active: bool
    created_at: UTCDateTime
    updated_at: UTCDateTime


class AgentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str
    description: str
    icon: str
    version: Optional[str] = None
    type: str = "langgraph agent"
    isActive: bool = Field(..., validation_alias="is_active")
    # Derived from ``owner_user_id`` (``AgentTable.kind``): a row with an owner
    # is that user's own agent. Lets the UI split "mine" from the platform's
    # without cross-checking the ``/custom`` list.
    kind: Literal["platform", "custom"] = "platform"
    # Custom agents only, and only when the gallery asks for them
    # (``/custom?include=summary``): read from the agents service's list
    # summary, so there is no per-agent call. ``None`` = not fetched.
    model: str | None = None
    toolCount: int | None = None
    skillCount: int | None = None
    subagentCount: int | None = None


class ModelChoice(BaseModel):
    """One entry of the user-agent model allowlist, in the agents service's order."""
    model_config = ConfigDict(populate_by_name=True)

    id: str
    label: str = ""
    default: bool = False


class BuiltinToolInfo(BaseModel):
    """A built-in tool a draft agent can be given, with its approval rules.

    ``hitlDefault`` is whether it pauses for approval before anyone chooses,
    ``locked`` whether that can be changed at all (``execute``), ``gateable``
    whether it can be gated, and ``mainOnly`` whether only the top-level agent
    (not a sub-agent) may have it.
    """
    model_config = ConfigDict(populate_by_name=True)

    name: str
    description: str = ""
    group: str = ""
    hitlDefault: bool = Field(False, validation_alias=AliasChoices("hitlDefault", "hitl_default"))
    locked: bool = False
    gateable: bool = True
    mainOnly: bool = Field(False, validation_alias=AliasChoices("mainOnly", "main_only"))


class ToolManifest(BaseModel):
    server_id: str = Field("", validation_alias="server_id")
    tool_name: str = Field(..., validation_alias="tool_name")
    description: str = ""
    parameter_count: int = Field(0, ge=0, validation_alias="parameter_count")
