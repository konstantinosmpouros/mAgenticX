"""Per-(user, agent) tool-control DTOs: the Agents-tab tool rows and the
enable/disable toggle request."""
from typing import List, Literal
from pydantic import BaseModel, Field


class AgentToolRow(BaseModel):
    """One tool an agent can use, with its per-(user, agent) disabled state.

    Rendered in the Agents tab; the user toggles ``disabled`` per agent."""

    key: str
    name: str
    description: str = ""
    source: Literal["native", "mcp"]
    # True = part of the agent's declared baseline (native builtin or agent.yaml
    # tool). False = an available gateway tool the user can enable for this agent.
    declared: bool = True
    disabled: bool


class AgentToolsResponse(BaseModel):
    """All tools for one agent, resolved for the requesting user."""
    agentSlug: str
    tools: List[AgentToolRow] = Field(default_factory=list)


class ToolToggleRequest(BaseModel):
    """Enable/disable one tool for this (user, agent) pair."""
    toolKey: str
    disabled: bool
