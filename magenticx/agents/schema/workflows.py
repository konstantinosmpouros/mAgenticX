"""Request/response schemas of the workflow endpoints (``router/workflows.py``).

The spec itself travels as a plain JSON object and is validated by
``harness.workflows.validator`` rather than as a typed body: that is what turns
a bad spec into node-addressed issues the builder can pin to each node, instead
of FastAPI's generic 422.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

#: Owner ids come from the bridge (the user's id); refused if they could ever
#: be anything but one opaque segment.
OWNER_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$"
#: The bridge's contract for workflow ids (ours are UUID strings, which fit).
WORKFLOW_ID_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"
RUN_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"
MAX_INPUT_BYTES = 64 * 1024


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WorkflowWrite(_Strict):
    """Body of create / update / validate: the spec as JSON."""

    spec: dict[str, Any]


class WorkflowIssue(BaseModel):
    """One validation problem, pinned to a node (or ``None``) and a spec path."""

    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    node_id: str | None = Field(default=None, alias="nodeId")
    path: str
    message: str


class WorkflowValidation(BaseModel):
    """``POST /workflows/validate``."""

    ok: bool
    errors: list[WorkflowIssue]


class WorkflowSummary(BaseModel):
    """One row of the owner's list."""

    id: str
    owner_user_id: str
    name: str
    description: str
    latest_version_no: int
    created_at: datetime
    updated_at: datetime


class WorkflowDetail(WorkflowSummary):
    """One workflow: its draft and its newest version's spec."""

    draft: dict[str, Any]
    spec: dict[str, Any] | None


class WorkflowVersionSummary(BaseModel):
    """One kept version as the History list shows it: no spec, a short summary.

    ``restored_from`` names the version a restore copied (a restore appends a
    new version; history is never rewritten). ``name`` / ``description`` /
    ``node_count`` / ``edge_count`` are read off the version's own spec.
    """

    version_no: int
    created_at: datetime
    created_by: str
    restored_from: int | None = None
    name: str
    description: str
    node_count: int
    edge_count: int


class WorkflowVersionPage(BaseModel):
    """``GET /workflows/{owner}/{id}/versions``: newest first.

    ``next_before`` is the ``before`` to pass for the next (older) page; null
    on the last one.
    """

    items: list[WorkflowVersionSummary]
    next_before: int | None = None


class WorkflowVersionDetail(BaseModel):
    """One kept version with its whole spec, for a diff, a preview or a restore."""

    version_no: int
    created_at: datetime
    created_by: str
    restored_from: int | None = None
    spec: dict[str, Any]


class WorkflowCatalog(BaseModel):
    """``GET /workflows/catalog``: every node kind with its config schema."""

    kinds: list[dict[str, Any]]


class WorkflowResume(_Strict):
    """The answer to an ``approval`` pause."""

    decision: Literal["approve", "reject"]
    comment: str | None = Field(default=None, max_length=2000)


class WorkflowRunRequest(_Strict):
    """``POST /workflows/runs/stream`` — start a run, or resume a paused one.

    ``version_no`` ``None`` runs the newest version. A resume names the same
    ``thread_id`` as the paused run; its ``inputs`` are ignored.
    ``trigger_kind`` / ``fired_at`` say how and when the run was started (a
    bridge scheduler fire is ``schedule``); the trigger node reports them.
    """

    run_id: str = Field(pattern=RUN_ID_PATTERN)
    thread_id: str = Field(pattern=RUN_ID_PATTERN)
    owner_user_id: str = Field(pattern=OWNER_ID_PATTERN)
    workflow_id: str = Field(pattern=WORKFLOW_ID_PATTERN)
    version_no: int | None = Field(default=None, ge=1)
    inputs: dict[str, Any] = Field(default_factory=dict)
    resume: WorkflowResume | None = None
    trigger_kind: Literal["manual", "schedule"] = "manual"
    fired_at: datetime | None = None


__all__ = [
    "MAX_INPUT_BYTES",
    "OWNER_ID_PATTERN",
    "WORKFLOW_ID_PATTERN",
    "WorkflowCatalog",
    "WorkflowDetail",
    "WorkflowIssue",
    "WorkflowResume",
    "WorkflowRunRequest",
    "WorkflowSummary",
    "WorkflowValidation",
    "WorkflowVersionDetail",
    "WorkflowVersionPage",
    "WorkflowVersionSummary",
    "WorkflowWrite",
]
