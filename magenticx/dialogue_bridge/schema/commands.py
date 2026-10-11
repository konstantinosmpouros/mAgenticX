"""Slash commands (plan 35): an invocation on a user message, and the catalog the
composer's ``/`` menu lists (proxied from the agents service)."""
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

#: What follows the ``/`` — the agents service's ``COMMAND.md`` name rule.
COMMAND_NAME_PATTERN = r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"


class CommandInvocation(BaseModel):
    """The command a user message runs. Only the name: the command's argument is
    the message's content, and its instruction lives in the agents service —
    never sent by the browser."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=40, pattern=COMMAND_NAME_PATTERN)


class CommandOut(BaseModel):
    """One command for one agent; ``available`` false keeps it listed, with the reason."""

    name: str
    kind: Literal["action", "prompt"]
    description: str
    argumentHint: str = ""
    readOnly: bool = False
    source: str = "builtin"
    available: bool = True
    unavailableReason: Optional[str] = None


class CommandListResponse(BaseModel):
    """The ``/`` menu for one (user, agent)."""

    commands: List[CommandOut]
