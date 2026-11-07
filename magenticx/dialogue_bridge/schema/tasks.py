"""Background sub-agent task DTOs (plan 41 §14): the shapes the agents service,
the bridge and the UI agree on.

``TaskOut`` and ``OutboxItem`` are written by the agents service (Redis
streams, internal HTTP) and validated here before anything is stored or
forwarded; ``TaskOut`` is also what the bridge serves to the browser from its
``conversation_tasks`` mirror. Field names are snake_case on purpose — they
are the cross-service contract (§14), identical in agents, bridge and UI.

Every free-text field coming from the agents service is clipped rather than
rejected: a too-long description must not turn a status update into a poison
entry that blocks the stream.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from schema.base import UTCDateTime
from schema.commands import CommandInvocation
from schema.inference import InferenceRunOut, InferenceRunResumeIn

#: §14.1. The last three are the settled statuses.
AsyncTaskStatus = Literal["pending", "running", "waiting_children", "waiting", "success", "error", "cancelled"]
#: The events of the ``tasks:status`` stream (§14.2) and of the conversation channel.
TaskStatusEvent = Literal["TASK_STARTED", "TASK_STATUS", "TASK_SETTLED"]

#: Clip limits for the agents service's free text (characters).
_NAME_MAX = 200
_PATH_MAX = 1000
_DESCRIPTION_MAX = 10_000
_PREVIEW_MAX = 2000
_ERROR_MAX = 2000
_ID_MAX = 200


def _clip(value: Any, limit: int) -> Any:
    """Clip a string to ``limit`` characters; anything else passes unchanged."""
    return value[:limit] if isinstance(value, str) and len(value) > limit else value


class TaskUsage(BaseModel):
    """What a task's runs spent, summed by the agents service.

    ``input_tokens`` / ``output_tokens`` are the §14.1 fields; the others are
    optional (0 when not reported) and let the usage breakdown carry the same
    detail as a run's own groups.
    """
    model_config = ConfigDict(extra="ignore")

    input_tokens: int = Field(0, ge=0)
    output_tokens: int = Field(0, ge=0)
    cached_input_tokens: int = Field(0, ge=0)
    reasoning_tokens: int = Field(0, ge=0)
    calls: int = Field(0, ge=0)
    model_latency_ms: int = Field(0, ge=0)


class TaskOut(BaseModel):
    """One background sub-agent task (§14.1)."""
    model_config = ConfigDict(from_attributes=True, extra="ignore")

    task_id: str = Field(..., min_length=1, max_length=_ID_MAX)
    conversation_id: str = Field(..., min_length=1, max_length=_ID_MAX)
    user_id: str = Field(..., min_length=1, max_length=_ID_MAX)
    parent_task_id: Optional[str] = Field(None, max_length=_ID_MAX)
    root_run_id: Optional[str] = Field(None, max_length=_ID_MAX)
    branch_thread_id: Optional[str] = Field(None, max_length=_ID_MAX)
    spawned_by_message_id: Optional[str] = Field(None, max_length=_ID_MAX)
    depth: int = Field(1, ge=1, le=10)
    name: str = Field(..., min_length=1)
    subagent_path: Optional[str] = None
    description: Optional[str] = None
    model: Optional[str] = None
    status: AsyncTaskStatus
    result_preview: Optional[str] = None
    error: Optional[str] = None
    usage: TaskUsage = Field(default_factory=TaskUsage)
    started_at: Optional[UTCDateTime] = None
    settled_at: Optional[UTCDateTime] = None

    @field_validator("name", mode="before")
    @classmethod
    def _clip_name(cls, value: Any) -> Any:
        return _clip(value, _NAME_MAX)

    @field_validator("subagent_path", mode="before")
    @classmethod
    def _clip_path(cls, value: Any) -> Any:
        return _clip(value, _PATH_MAX)

    @field_validator("model", mode="before")
    @classmethod
    def _clip_model(cls, value: Any) -> Any:
        return _clip(value, _NAME_MAX)

    @field_validator("description", mode="before")
    @classmethod
    def _clip_description(cls, value: Any) -> Any:
        return _clip(value, _DESCRIPTION_MAX)

    @field_validator("result_preview", mode="before")
    @classmethod
    def _clip_preview(cls, value: Any) -> Any:
        return _clip(value, _PREVIEW_MAX)

    @field_validator("error", mode="before")
    @classmethod
    def _clip_error(cls, value: Any) -> Any:
        return _clip(value, _ERROR_MAX)

    @field_validator("usage", mode="before")
    @classmethod
    def _usage_or_empty(cls, value: Any) -> Any:
        return value if isinstance(value, dict) else {}

    @property
    def settled(self) -> bool:
        return self.status in ("success", "error", "cancelled")


class TaskStatusEntry(BaseModel):
    """One ``tasks:status`` stream entry (§14.2): an event and the task as it now is."""
    event: TaskStatusEvent
    task: TaskOut


class TaskNotification(BaseModel):
    """The notification HumanMessage the agents service built for a settled task."""
    model_config = ConfigDict(extra="ignore")

    content: list[dict[str, Any]] | str = Field(default_factory=list)
    additional_kwargs: dict[str, Any] = Field(default_factory=dict)


class OutboxItem(BaseModel):
    """One ``tasks:outbox`` entry / ``GET /tasks/unnotified`` item (§14.2).

    Written when a depth-1 task's whole subtree has settled: the doorbell that
    wakes the orchestrator. The durable truth is the agents service's
    ``async_tasks.parent_notified_at``.
    """
    model_config = ConfigDict(extra="ignore")

    task_id: str = Field(..., min_length=1, max_length=_ID_MAX)
    user_id: str = Field(..., min_length=1, max_length=_ID_MAX)
    conversation_id: str = Field(..., min_length=1, max_length=_ID_MAX)
    branch_thread_id: str = Field(..., min_length=1, max_length=_ID_MAX)
    root_run_id: Optional[str] = Field(None, max_length=_ID_MAX)
    agent_slug: Optional[str] = Field(None, max_length=_NAME_MAX)
    interactive: bool = True
    status: Literal["success", "error", "cancelled"]
    cancelled_by_user: bool = False
    notification: TaskNotification = Field(default_factory=TaskNotification)

    def notification_text(self) -> str:
        """The notification's text, as the notice row's content."""
        content = self.notification.content
        if isinstance(content, str):
            return content
        parts = [
            block["text"]
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        ]
        return "\n\n".join(parts)


class TaskResumeIn(InferenceRunResumeIn):
    """``POST /tasks/{user_id}/{task_id}/resume``: an approval decision for a
    ``waiting`` task — the same body as a run's resume (§14.4). ``interruptId``
    is required: a task's pause is answered interrupt by interrupt."""

    @model_validator(mode="after")
    def _require_interrupt_id(self) -> "TaskResumeIn":
        if not self.interruptId:
            raise ValueError("interruptId is required to answer a task's approval.")
        return self


class QueuedMessageOut(BaseModel):
    """The conversation's one queued composer message (§3.6, §14.4)."""
    model_config = ConfigDict(extra="ignore")

    content: Optional[str] = None
    command: Optional[CommandInvocation] = None
    agent_id: str
    queued_at: UTCDateTime


class QueuedStartResponse(BaseModel):
    """``POST /runs/{user_id}/start`` with ``queue_if_busy`` on a busy
    conversation: 202, the message is held and sent when the run ends."""
    queued: Literal[True] = True
    queued_message: QueuedMessageOut


# Conversation channel frames (§14.4) — the server side of
# /conversations/{user_id}/{conversation_id}/ws.
class TaskFrame(BaseModel):
    type: Literal["task"] = "task"
    event: TaskStatusEvent
    task: TaskOut


class RunStartedFrame(BaseModel):
    type: Literal["run_started"] = "run_started"
    run: InferenceRunOut
    # True when the run is the conversation's queued message being sent.
    from_queue: bool = False


class QueueFrame(BaseModel):
    type: Literal["queue"] = "queue"
    queued_message: Optional[QueuedMessageOut] = None


def queued_message_from_column(value: Any) -> Optional[QueuedMessageOut]:
    """``conversations.queued_message`` → its wire shape, or None when empty/invalid."""
    if not isinstance(value, dict):
        return None
    try:
        return QueuedMessageOut.model_validate(value)
    except ValueError:
        return None
