"""Agent + MCP tool catalog DTOs."""
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field
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


class ToolManifest(BaseModel):
    server_id: str = Field("", validation_alias="server_id")
    tool_name: str = Field(..., validation_alias="tool_name")
    description: str = ""
    parameter_count: int = Field(0, ge=0, validation_alias="parameter_count")
