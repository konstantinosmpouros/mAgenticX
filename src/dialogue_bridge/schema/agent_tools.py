"""Per-(user, agent) tool-control DTOs (Agents tab), mirroring the agents-service shapes."""
from pydantic import BaseModel, ConfigDict, Field


class AgentToolRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str
    name: str
    description: str = ""
    source: str  # "native" | "mcp"
    declared: bool = True  # part of the agent's baseline vs an available gateway tool
    disabled: bool


class AgentToolsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    agentSlug: str
    tools: list[AgentToolRow] = Field(default_factory=list)


class ToolToggleRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    toolKey: str
    disabled: bool
