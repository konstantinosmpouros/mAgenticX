"""Scheduled-task DTOs plus the shared schedule normalization/validation helpers."""
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from datetime import datetime, timezone
from core.settings import settings
from schema.base import UTCDateTime

# Optional at import: croniter (third-party) and a working tz database may be
# absent on a bare dev host. Guarded at module top so the module always loads;
# the validators below degrade leniently when a lib is missing — prod/containers
# carry both and validate strictly.
try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:
    ZoneInfo = None
    ZoneInfoNotFoundError = None
try:
    from croniter import croniter
except ImportError:
    croniter = None


ScheduleKind = Literal["one_off", "interval", "cron"]


TaskTargetMode = Literal["fresh", "bound"]


TaskStatus = Literal["active", "paused", "completed", "failed"]


def _to_naive_utc(value: datetime) -> datetime:
    """Normalize an inbound datetime to naive-UTC (the storage convention).

    Offset-aware input is converted to UTC then stripped; naive input is assumed
    to already be UTC (the client sends UTC ISO strings).
    """
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _validate_timezone(tz: str) -> None:
    """Reject an unknown IANA tz. Lenient where the tz database is unavailable
    (e.g. a bare Windows host with no ``tzdata``) so validation never depends on
    the host's zoneinfo — prod/containers carry ``tzdata`` and reject bad zones."""
    if ZoneInfo is None:
        return
    try:
        ZoneInfo(tz)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone: {tz!r}.") from exc
    except Exception:
        return


def _validate_cron(expr: str) -> None:
    if croniter is None:
        return
    if not croniter.is_valid(expr):
        raise ValueError(f"Invalid cron expression: {expr!r}.")


def _normalize_schedule(
    kind: ScheduleKind,
    run_at: Optional[datetime],
    interval_seconds: Optional[int],
    cron_expr: Optional[str],
    timezone_value: Optional[str],
    *,
    now: datetime,
) -> tuple[Optional[datetime], Optional[str], Optional[str]]:
    """Validate + normalize the per-kind schedule fields, returning the cleaned
    (run_at, cron_expr, timezone). Shared by create and edit so both enforce the
    same rules (future runAt, min interval, valid cron/tz)."""
    if kind == "one_off":
        if run_at is None:
            raise ValueError("runAt is required for a one_off task.")
        run_at = _to_naive_utc(run_at)
        if run_at <= now:
            raise ValueError("runAt must be in the future.")
    elif kind == "interval":
        if interval_seconds is None:
            raise ValueError("intervalSeconds is required for an interval task.")
        if interval_seconds < settings.scheduler.min_interval_seconds:
            raise ValueError(f"intervalSeconds must be at least {settings.scheduler.min_interval_seconds}.")
    else:  # cron
        if not (cron_expr or "").strip():
            raise ValueError("cronExpr is required for a cron task.")
        cron_expr = cron_expr.strip()
        _validate_cron(cron_expr)
        if timezone_value:
            timezone_value = timezone_value.strip()
            _validate_timezone(timezone_value)
        else:
            timezone_value = "UTC"
    return run_at, cron_expr, timezone_value


class ScheduledTaskCreate(BaseModel):
    """Create a scheduled task. Exactly one schedule field must match the kind:
    ``one_off`` → ``runAt``; ``interval`` → ``intervalSeconds``; ``cron`` → ``cronExpr``."""
    agentId: str
    prompt: str
    title: Optional[str] = None
    targetMode: TaskTargetMode = "fresh"
    scheduleKind: ScheduleKind
    runAt: Optional[datetime] = None
    intervalSeconds: Optional[int] = None
    cronExpr: Optional[str] = None
    timezone: Optional[str] = None
    isPrivate: bool = False
    maxRuns: Optional[int] = Field(None, ge=1)
    expiresAt: Optional[datetime] = None

    @model_validator(mode="after")
    def _validate(self) -> "ScheduledTaskCreate":
        self.prompt = (self.prompt or "").strip()
        if not self.prompt:
            raise ValueError("prompt is required.")
        if len(self.prompt) > 8000:
            raise ValueError("prompt must be 8000 characters or fewer.")
        if self.title is not None:
            self.title = self.title.strip()[:200] or None
        if not (self.agentId or "").strip():
            raise ValueError("agentId is required.")
        self.agentId = self.agentId.strip()

        now = datetime.now(timezone.utc).replace(tzinfo=None)
        self.runAt, self.cronExpr, self.timezone = _normalize_schedule(
            self.scheduleKind, self.runAt, self.intervalSeconds, self.cronExpr, self.timezone, now=now
        )

        if self.expiresAt is not None:
            self.expiresAt = _to_naive_utc(self.expiresAt)
            if self.expiresAt <= now:
                raise ValueError("expiresAt must be in the future.")
        return self


class ScheduledTaskUpdate(BaseModel):
    """Partial update — any field may be omitted to leave it unchanged. Pause/resume
    is via ``status``. To change the cadence, send ``scheduleKind`` plus its matching
    field (``runAt``/``intervalSeconds``/``cronExpr``); the util recomputes ``next_run_at``."""
    title: Optional[str] = None
    prompt: Optional[str] = None
    status: Optional[Literal["active", "paused"]] = None
    agentId: Optional[str] = None
    targetMode: Optional[TaskTargetMode] = None
    isPrivate: Optional[bool] = None
    maxRuns: Optional[int] = Field(None, ge=1)
    expiresAt: Optional[datetime] = None
    scheduleKind: Optional[ScheduleKind] = None
    runAt: Optional[datetime] = None
    intervalSeconds: Optional[int] = None
    cronExpr: Optional[str] = None
    timezone: Optional[str] = None

    @model_validator(mode="after")
    def _normalize(self) -> "ScheduledTaskUpdate":
        if self.prompt is not None:
            self.prompt = self.prompt.strip()
            if not self.prompt:
                raise ValueError("prompt cannot be empty.")
            if len(self.prompt) > 8000:
                raise ValueError("prompt must be 8000 characters or fewer.")
        if self.title is not None:
            self.title = self.title.strip()[:200] or None
        if self.agentId is not None:
            self.agentId = self.agentId.strip()
            if not self.agentId:
                raise ValueError("agentId cannot be empty.")
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        if self.scheduleKind is not None:
            self.runAt, self.cronExpr, self.timezone = _normalize_schedule(
                self.scheduleKind, self.runAt, self.intervalSeconds, self.cronExpr, self.timezone, now=now
            )
        if self.expiresAt is not None:
            self.expiresAt = _to_naive_utc(self.expiresAt)
            if self.expiresAt <= now:
                raise ValueError("expiresAt must be in the future.")
        return self


class ScheduledTaskOut(BaseModel):
    """A scheduled task as the frontend management panel sees it.

    ``liveStatus`` and ``lastRunConversationId`` are derived (the util sets them
    after ``model_validate`` from a lookup of ``last_run_message_id``) — they are
    not ORM columns, so they default to None when validated straight from a row.
    """
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    agentId: Optional[str] = Field(None, validation_alias="agent_id")
    agentName: Optional[str] = Field(None, validation_alias="agent_name")
    agentSlug: Optional[str] = Field(None, validation_alias="agent_slug")
    conversationId: Optional[str] = Field(None, validation_alias="conversation_id")
    title: Optional[str] = None
    prompt: str
    isPrivate: bool = Field(False, validation_alias="is_private")
    targetMode: str = Field("fresh", validation_alias="target_mode")
    scheduleKind: str = Field(..., validation_alias="schedule_kind")
    scheduleSpec: dict = Field(default_factory=dict, validation_alias="schedule_spec")
    timezone: Optional[str] = None
    status: str
    nextRunAt: Optional[UTCDateTime] = Field(None, validation_alias="next_run_at")
    lastRunAt: Optional[UTCDateTime] = Field(None, validation_alias="last_run_at")
    lastRunStatus: Optional[str] = Field(None, validation_alias="last_run_status")
    lastRunMessageId: Optional[str] = Field(None, validation_alias="last_run_message_id")
    lastError: Optional[str] = Field(None, validation_alias="last_error")
    runCount: int = Field(0, validation_alias="run_count")
    maxRuns: Optional[int] = Field(None, validation_alias="max_runs")
    expiresAt: Optional[UTCDateTime] = Field(None, validation_alias="expires_at")
    createdAt: UTCDateTime = Field(..., validation_alias="created_at")
    updatedAt: UTCDateTime = Field(..., validation_alias="updated_at")

    # Derived, set by the util after model_validate (not ORM columns).
    liveStatus: Optional[str] = None
    lastRunConversationId: Optional[str] = None

    @field_validator("scheduleSpec", mode="before")
    @classmethod
    def _coerce_spec(cls, value):
        return value if isinstance(value, dict) else {}
