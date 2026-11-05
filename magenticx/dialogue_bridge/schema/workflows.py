"""Workflow DTOs (plan 38): definitions proxied to the agents service, and runs.

A workflow *definition* is the agents service's (``agent_runtime``); the bridge
forwards it behind authz, CSRF and rate limits, and validates what comes back.
A workflow *run* is the bridge's own entity (``workflow_runs`` +
``workflow_run_events``) — never an agent row, a conversation or a message.

camelCase on the wire like the rest of the bridge; snake_case in (ORM rows and
agents-service bodies) via ``validation_alias``.
"""
import json
from datetime import datetime
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from core.settings import settings
from schema.base import UTCDateTime
from schema.scheduled_tasks import ScheduleKind

WorkflowRunStatus = Literal["queued", "running", "waiting", "succeeded", "failed", "cancelled"]
#: How a run was started: "Run now", or a ``workflow_schedules`` fire.
WorkflowTriggerKind = Literal["manual", "schedule"]


def _json_size(value: Any) -> int:
    """Serialised size in bytes — what the agents service and the DB will hold."""
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


# ---------------------------------------------------------------------------
# Definitions (proxied)
# ---------------------------------------------------------------------------
class WorkflowWrite(BaseModel):
    """Create/update/validate body: the workflow spec, forwarded verbatim.

    The agents service validates it against the engine's own model, so the wire
    contract cannot drift from the runtime one; the bridge only bounds its size
    so an oversized body never reaches the upstream at all.
    """
    model_config = ConfigDict(populate_by_name=True)

    spec: dict[str, Any] = Field(default_factory=dict)

    @field_validator("spec", mode="after")
    @classmethod
    def _bound_spec(cls, value: dict[str, Any]) -> dict[str, Any]:
        if _json_size(value) > settings.workflows.max_spec_bytes:
            raise ValueError("The workflow is too large.")
        return value


class WorkflowValidationIssue(BaseModel):
    """One problem with a spec; ``nodeId`` is null for a workflow-level issue."""
    model_config = ConfigDict(populate_by_name=True)

    nodeId: str | None = Field(None, validation_alias=AliasChoices("nodeId", "node_id"))
    path: str = ""
    message: str


class WorkflowValidation(BaseModel):
    """The result of ``POST /v1/workflows/validate``."""
    model_config = ConfigDict(populate_by_name=True)

    ok: bool
    errors: list[WorkflowValidationIssue] = Field(default_factory=list)


WorkflowScheduleStatus = Literal["active", "paused", "finished"]

#: The start-node kind that schedules a workflow.
SCHEDULE_TRIGGER_KIND = "trigger.schedule"


class WorkflowScheduleSpec(BaseModel):
    """``schedule_spec`` of a ``trigger.schedule`` node: the kind's one parameter."""
    model_config = ConfigDict(extra="forbid")

    run_at: datetime | None = None
    interval_seconds: int | None = Field(None, ge=1)
    cron_expr: str | None = Field(None, min_length=1, max_length=120)


class WorkflowScheduleTrigger(BaseModel):
    """The config of a saved ``trigger.schedule`` node, as the bridge reads it
    back from the agents service before it schedules anything.

    The engine has already validated it; this is output validation of an
    upstream body, so it is as strict about types and the kind ↔ spec pairing
    and lenient only about keys the bridge does not use (``assign``). Its
    cadence rules (the minimum interval, a valid cron and zone) are applied by
    :func:`utils.workflow_schedules.desired_schedule` with the bridge's own
    settings.
    """
    model_config = ConfigDict(extra="ignore")

    schedule_kind: ScheduleKind
    schedule_spec: WorkflowScheduleSpec
    timezone: str | None = Field(None, max_length=64)
    inputs: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True

    @field_validator("inputs", mode="after")
    @classmethod
    def _bound_inputs(cls, value: dict[str, Any]) -> dict[str, Any]:
        if _json_size(value) > settings.workflows.max_input_bytes:
            raise ValueError("The scheduled run inputs are too large.")
        return value


class WorkflowScheduleOut(BaseModel):
    """A workflow's schedule as the bridge's scheduler holds it.

    Read from the ``workflow_schedules`` row, which mirrors the workflow's
    ``trigger.schedule`` start node. ``kind`` / ``spec`` / ``timezone`` have
    the scheduled-task shapes (``spec``: ``{run_at}`` | ``{interval_seconds}``
    | ``{cron_expr}``). ``lastRunStatus`` is the newest fire's run status
    while that run still exists (``queued`` … ``cancelled``), else what the
    fire recorded (``skipped`` while a run was live, ``failed``).
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    status: WorkflowScheduleStatus
    kind: str = Field(validation_alias=AliasChoices("kind", "schedule_kind"))
    spec: dict[str, Any] = Field(default_factory=dict, validation_alias=AliasChoices("spec", "schedule_spec"))
    timezone: str | None = None
    nextRunAt: UTCDateTime | None = Field(None, validation_alias=AliasChoices("nextRunAt", "next_run_at"))
    lastRunAt: UTCDateTime | None = Field(None, validation_alias=AliasChoices("lastRunAt", "last_run_at"))
    lastRunStatus: str | None = Field(
        None, validation_alias=AliasChoices("lastRunStatus", "last_run_status")
    )

    @field_validator("spec", mode="before")
    @classmethod
    def _coerce_spec(cls, value: Any) -> Any:
        return value if isinstance(value, dict) else {}


class WorkflowOut(BaseModel):
    """A workflow definition as the agents service stores it.

    ``spec`` is optional so a list endpoint that returns summaries only still
    validates. ``schedule`` is the bridge's own: the workflow's schedule when
    its start node is an enabled ``trigger.schedule``, else ``null`` (set by
    :mod:`utils.workflow_schedules`, never by the upstream body).
    """
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    description: str | None = None
    spec: dict[str, Any] | None = None
    latestVersionNo: int | None = Field(
        None, validation_alias=AliasChoices("latestVersionNo", "latest_version_no")
    )
    createdAt: UTCDateTime | None = Field(None, validation_alias=AliasChoices("createdAt", "created_at"))
    updatedAt: UTCDateTime | None = Field(None, validation_alias=AliasChoices("updatedAt", "updated_at"))
    schedule: WorkflowScheduleOut | None = None


# ---------------------------------------------------------------------------
# Runs (the bridge's own)
# ---------------------------------------------------------------------------
class WorkflowRunStart(BaseModel):
    """``POST …/runs``: the run's inputs (the trigger's output), bounded."""
    model_config = ConfigDict(populate_by_name=True)

    inputs: dict[str, Any] = Field(default_factory=dict)

    @field_validator("inputs", mode="after")
    @classmethod
    def _bound_inputs(cls, value: dict[str, Any]) -> dict[str, Any]:
        if _json_size(value) > settings.workflows.max_input_bytes:
            raise ValueError("The run inputs are too large.")
        return value


class WorkflowRunStarted(BaseModel):
    """The id of the run just started; its events follow on the event stream."""
    runId: str


class WorkflowRunResume(BaseModel):
    """An answer to the approval node a ``waiting`` run is paused on."""
    model_config = ConfigDict(populate_by_name=True)

    decision: Literal["approve", "reject"]
    comment: str | None = Field(None, max_length=4000)

    @field_validator("comment", mode="after")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class WorkflowRunOut(BaseModel):
    """One run's row. ``inputs`` is left out of list pages (see the run detail)."""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    workflowId: str = Field(validation_alias="workflow_id")
    workflowName: str = Field(validation_alias="workflow_name")
    versionNo: int | None = Field(None, validation_alias="version_no")
    triggerKind: str = Field(validation_alias="trigger_kind")
    status: WorkflowRunStatus
    error: str | None = None
    eventCount: int = Field(0, validation_alias="event_count")
    startedAt: UTCDateTime = Field(validation_alias="started_at")
    finishedAt: UTCDateTime | None = Field(None, validation_alias="finished_at")
    createdAt: UTCDateTime = Field(validation_alias="created_at")
    updatedAt: UTCDateTime = Field(validation_alias="updated_at")


class WorkflowRunPage(BaseModel):
    """A page of one workflow's runs, newest first. Pass ``nextCursor`` back as
    ``?cursor=`` for the next page; it is null on the last one."""
    items: list[WorkflowRunOut]
    nextCursor: str | None = None


class WorkflowRunEventOut(BaseModel):
    """One persisted AG-UI event of a run. ``payload`` is the event as the
    engine emitted it (its ``workflow`` block included), or a truncation
    marker with a preview when it exceeded the per-event size cap."""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    seq: int
    type: str
    nodeId: str | None = Field(None, validation_alias="node_id")
    executionId: str | None = Field(None, validation_alias="execution_id")
    parentExecutionId: str | None = Field(None, validation_alias="parent_execution_id")
    payload: dict[str, Any]
    createdAt: UTCDateTime = Field(validation_alias="created_at")


class WorkflowRunDetail(BaseModel):
    """A run with its events, oldest first. A very long run comes in pages:
    while ``hasMoreEvents`` is true, ask again with ``?after_seq=`` set to the
    last event's ``seq``."""
    run: WorkflowRunOut
    inputs: dict[str, Any] = Field(default_factory=dict)
    events: list[WorkflowRunEventOut]
    hasMoreEvents: bool = False
