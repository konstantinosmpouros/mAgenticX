"""Agents-tab tool DTOs, mirroring the agents-service shapes."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


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
