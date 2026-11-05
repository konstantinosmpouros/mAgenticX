"""``trigger.schedule`` — the entry of a workflow that also runs on a clock.

A workflow is scheduled by its start node: the builder offers ``trigger.manual``
or ``trigger.schedule`` as the first node. The schedule itself is plain data on
this node's config — the **source of truth**. On every save the bridge reads it
back from the saved spec and materialises it as one ``workflow_schedules`` row,
whose scheduler fires the workflow; nothing here runs a timer.

The config mirrors the bridge's scheduled-task schedule model field for field
(``schedule_kind`` + ``schedule_spec`` + ``timezone``, the same three kinds,
the same minimum interval), so the bridge can hand it to the same next-fire
computation unchanged:

=========== =============================================== ================
kind        ``schedule_spec``                               ``timezone``
=========== =============================================== ================
``one_off`` ``{"run_at": "<ISO 8601>"}`` (naive = UTC)       ignored
``interval``  ``{"interval_seconds": n}`` (≥ 300)           ignored
``cron``    ``{"cron_expr": "<5-field cron>"}``             IANA, default UTC
=========== =============================================== ================

``inputs`` are the literal run inputs of a scheduled fire, checked against the
workflow's declared inputs (unknown names, types, and — while ``enabled`` —
every required input without a default). The config is **not templated**: it is
data, so a ``{{`` in an input value is kept as text.

A scheduled workflow can still be run by hand. The run request's inputs are
merged **over** these static ones (:func:`static_inputs`), and the node reports
how the run started: ``{trigger: "schedule"|"manual", firedAt, inputs}``.

A one-off moment in the past is not an error here: the stored spec is
re-validated at every run start, so refusing it would break "Run now" once the
one-off has fired. The bridge simply schedules nothing for it.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from harness.workflows.nodes.base import (
    NodeConfig,
    NodeContext,
    NodeResult,
    ValidationContext,
    WorkflowNode,
)
from harness.workflows.spec import MAX_INPUTS, WorkflowSpec, type_matches

# Optional at import, as in the bridge's schedule schema: validation degrades
# leniently where croniter or a tz database is missing (a bare dev host); the
# image carries both (requirements.txt) and validates strictly.
try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:
    ZoneInfo = None
    ZoneInfoNotFoundError = None
try:
    from croniter import croniter
except ImportError:
    croniter = None

KIND = "trigger.schedule"
#: The floor on a recurring cadence — the bridge's ``SCHEDULER_MIN_INTERVAL_SECONDS``
#: default, so a workflow cannot hammer the engine any harder than a scheduled task.
MIN_INTERVAL_SECONDS = 300
#: One year: anything longer is a one-off in disguise.
MAX_INTERVAL_SECONDS = 366 * 24 * 3600
MAX_CRON_CHARS = 120
MAX_TIMEZONE_CHARS = 64

ScheduleKind = Literal["one_off", "interval", "cron"]
#: The ``schedule_spec`` field each kind requires (and the only one it allows).
_SPEC_FIELD: dict[str, str] = {"one_off": "run_at", "interval": "interval_seconds", "cron": "cron_expr"}


class ScheduleSpec(BaseModel):
    """The kind's parameters — exactly the bridge's ``scheduled_tasks.schedule_spec``."""

    model_config = ConfigDict(extra="forbid")

    run_at: datetime | None = Field(
        default=None, description="one_off: when to run (ISO 8601; without an offset it is UTC)."
    )
    interval_seconds: int | None = Field(
        default=None,
        ge=MIN_INTERVAL_SECONDS,
        le=MAX_INTERVAL_SECONDS,
        description=f"interval: seconds between runs (at least {MIN_INTERVAL_SECONDS}).",
    )
    cron_expr: str | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_CRON_CHARS,
        description="cron: a standard 5-field cron expression, read in `timezone`.",
    )

    @field_validator("cron_expr", mode="after")
    @classmethod
    def _valid_cron(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if croniter is not None and not croniter.is_valid(value):
            raise ValueError("Invalid cron expression.")
        return value


class ScheduleTriggerConfig(NodeConfig):
    """When the workflow runs on its own, and with which inputs."""

    schedule_kind: ScheduleKind = Field(description="one_off, interval or cron.")
    schedule_spec: ScheduleSpec = Field(description="The kind's one parameter (see each field).")
    timezone: str | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_TIMEZONE_CHARS,
        description="IANA timezone a cron expression is read in (default UTC). Ignored by the other kinds.",
    )
    inputs: dict[str, Any] = Field(
        default_factory=dict,
        max_length=MAX_INPUTS,
        description="Run inputs of a scheduled run: {input name: literal value}. Not templated.",
    )
    enabled: bool = Field(default=True, description="Off: the workflow keeps its schedule but never fires on it.")

    @field_validator("timezone", mode="after")
    @classmethod
    def _valid_timezone(cls, value: str | None) -> str | None:
        if value is None or ZoneInfo is None:
            return value
        value = value.strip()
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Unknown timezone.") from exc
        return value

    @model_validator(mode="after")
    def _spec_matches_kind(self) -> ScheduleTriggerConfig:
        wanted = _SPEC_FIELD[self.schedule_kind]
        given = {name for name in _SPEC_FIELD.values() if getattr(self.schedule_spec, name) is not None}
        if wanted not in given:
            raise ValueError(f"schedule_spec.{wanted} is required for a {self.schedule_kind} schedule.")
        extra = sorted(given - {wanted})
        if extra:
            raise ValueError(f"A {self.schedule_kind} schedule takes only schedule_spec.{wanted}; remove {', '.join(extra)}.")
        return self


class ScheduleTriggerNode(WorkflowNode):
    """Entry node of a scheduled workflow; does no work of its own."""

    kind = KIND
    label = "Schedule"
    group = "trigger"
    description = (
        "Starts the workflow on a schedule (once, every N seconds, or on a cron expression) "
        "with fixed inputs; it can still be run by hand. Output: {trigger, firedAt, inputs}."
    )
    is_trigger = True
    templated = False
    Config = ScheduleTriggerConfig

    def validate_semantics(self, ctx: ValidationContext) -> list[tuple[str, str]]:
        """The static inputs against the declared ones.

        Required inputs are only demanded while the schedule is enabled: a
        disabled schedule never fires, and a manual run supplies its own.
        """
        config: ScheduleTriggerConfig = self.config
        declared = {item.name: item for item in self.spec.inputs}
        issues: list[tuple[str, str]] = []
        for name, value in config.inputs.items():
            item = declared.get(name)
            if item is None:
                issues.append((f"inputs.{name}", f"'{name}' is not a declared input."))
            elif value is not None and not type_matches(item.type, value):
                issues.append((f"inputs.{name}", f"Input '{name}' must be of type {item.type}."))
        if config.enabled:
            for name, item in declared.items():
                if item.required and item.default is None and config.inputs.get(name) is None:
                    issues.append((f"inputs.{name}", f"A scheduled run needs a value for the required input '{name}'."))
        return issues

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        fired_at = ctx.run.fired_at or datetime.now(UTC).isoformat().replace("+00:00", "Z")
        return NodeResult(
            output={
                "trigger": "schedule" if ctx.run.trigger_kind == "schedule" else "manual",
                "firedAt": fired_at,
                "inputs": dict(state.get("input") or {}),
            }
        )


def static_inputs(spec: WorkflowSpec) -> dict[str, Any]:
    """The literal inputs of the spec's ``trigger.schedule`` node, or ``{}``.

    The runner lays a run request's inputs over these, so "Run now" on a
    scheduled workflow needs to supply only what it wants to change.
    """
    for node in spec.nodes:
        if node.kind == KIND:
            inputs = node.config.get("inputs")
            return dict(inputs) if isinstance(inputs, dict) else {}
    return {}


__all__ = [
    "KIND",
    "MIN_INTERVAL_SECONDS",
    "ScheduleSpec",
    "ScheduleTriggerConfig",
    "ScheduleTriggerNode",
    "static_inputs",
]
