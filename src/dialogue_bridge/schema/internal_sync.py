"""DTOs for the two-way workspace sync exchange (service-to-service only).

The agents service reports what its volume holds; the bridge answers with what
to change. Two calls rather than one, because a single call would have to carry
every file body on every pass — the inventory is names and hashes, and bodies
move only for the objects the reply actually asks for.

These are internal contracts, not browser-facing, but they are still validated:
the payload crosses a service boundary and a malformed inventory must fail at
the edge rather than half-apply.

**Agent definitions only.** Skills used to travel this exchange as a parallel
set of fields; they now live in ``agent_runtime`` with exactly one copy, so
there is nothing to compare and the fields were removed rather than left inert.
The exchange itself goes when plan 26 moves definitions too.
"""
from typing import List

from pydantic import BaseModel, Field


class InventoryAgent(BaseModel):
    """One custom-agent folder as the volume sees it."""

    slug: str
    # sha256 over the *authored* files only — the generated `agent.yaml` is
    # excluded, because the bridge never stores it (uploading one is rejected)
    # and including it would make every comparison mismatch.
    hash: str = ""


class SyncInventory(BaseModel):
    """Everything one user's workspace holds on the volume."""

    agents: List[InventoryAgent] = Field(default_factory=list)


class PlanAgent(BaseModel):
    """A definition the volume is missing or holds a diverged copy of."""

    slug: str
    spec: dict = Field(default_factory=dict)
    files: List[dict] = Field(default_factory=list)


class SyncPlan(BaseModel):
    """What the agents service should do about the inventory it just reported.

    ``write`` and ``remove`` are acted on directly. ``send`` names the objects
    the bridge has no content for and wants the bodies of — the volume is the
    only place they exist, which is exactly the state a half-failed create
    leaves behind.
    """

    write_agents: List[PlanAgent] = Field(default_factory=list)
    send_agents: List[str] = Field(default_factory=list)
    remove_agents: List[str] = Field(default_factory=list)


class ContentAgent(BaseModel):
    """A definition the bridge asked for, read off the volume."""

    slug: str
    spec: dict
    files: List[dict] = Field(default_factory=list)


class SyncContent(BaseModel):
    """Bodies for the objects a plan's ``send`` lists named."""

    agents: List[ContentAgent] = Field(default_factory=list)


class SyncAccepted(BaseModel):
    """What actually landed, for the caller's log line."""

    agents: int = 0
