"""Per-agent DTOs (Agents tab tools, the composer's effort picker), mirroring the agents-service shapes."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from schema.base import EffortLevel


class AgentToolRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str
    name: str
    description: str = ""
    kind: Literal["builtin", "mcp"]
    group: str
    declared: bool = True
    available: bool = True
    unavailableReason: Optional[str] = None
    enabled: bool
    approval: bool = False
    approvalLocked: bool = False


class AgentToolsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    agentSlug: str
    tools: list[AgentToolRow] = Field(default_factory=list)


class ToolEnabledRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    toolKey: str
    enabled: bool


class ToolApprovalRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    toolKey: str
    approval: bool



class ToolApprovalsRequest(BaseModel):
    """Every approval choice for one agent, applied together (the builder's save).

    ``True`` gates the tool, ``False`` clears a gate, ``None`` drops the user's
    choice so the tool follows the agent's own default again.
    """
    model_config = ConfigDict(populate_by_name=True)

    approvals: dict[str, bool | None] = Field(default_factory=dict)


class AgentModelResponse(BaseModel):
    """``GET /v1/agents/{user_id}/{agent_id}/model`` — the agent's model and the
    reasoning efforts it accepts, so the composer offers only levels that work.

    Proxied from the agents service, which alone knows the model and maps each
    level onto the provider's knob. Validated on the way out: an unknown level
    from upstream fails the response instead of reaching the browser. ``efforts``
    is empty and ``defaultEffort`` null for a model with no effort setting.
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    agentSlug: str
    model: str | None = None
    efforts: list[EffortLevel] = Field(default_factory=list)
    defaultEffort: EffortLevel | None = None
