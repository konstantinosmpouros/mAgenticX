"""Slash-command catalog DTOs (plan 35): what the composer's ``/`` menu lists."""
from typing import List, Literal, Optional

from pydantic import BaseModel


class CommandOut(BaseModel):
    """One command for one agent. ``available`` false keeps it listed, with the reason."""

    name: str
    kind: Literal["action", "prompt"]
    description: str
    argumentHint: str = ""
    readOnly: bool = False
    source: str = "builtin"
    available: bool = True
    unavailableReason: Optional[str] = None


class CommandListResponse(BaseModel):
    """Bridge ← agents: the commands for one (user, agent)."""

    agentSlug: str
    commands: List[CommandOut]
