"""Agents-tab tool DTOs: one row shape for both kinds of tool."""
from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class AgentToolRow(BaseModel):
    """One tool an agent can have, with the baseline this service knows.

    ``builtin`` tools are never enable-configurable — the framework ones are
    constructed inside ``create_deep_agent`` and the native ones follow the
    Personalization prefs. Only their approval is the user's to set.
    """

    key: str
    name: str
    description: str = ""
    kind: Literal["builtin", "mcp"]
    #: Display grouping: a builtin's family, or the MCP server id.
    group: str
    #: MCP: part of the agent's declared baseline. Always true for a builtin.
    declared: bool = True
    #: Whether this run/user actually has the tool (see harness/tools/builtins).
    available: bool = True
    unavailableReason: Optional[str] = None
    enabled: bool
    approval: bool = False
    #: Approval cannot be cleared by anyone.
    approvalLocked: bool = False


class AgentToolsResponse(BaseModel):
    """All tools for one agent, resolved for the requesting user."""

    agentSlug: str
    tools: List[AgentToolRow] = Field(default_factory=list)
