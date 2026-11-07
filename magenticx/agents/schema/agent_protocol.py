"""The Agent Protocol subset ``/ap`` serves (plan 41 §3.2) — what ``langgraph_sdk`` sends and reads.

deepagents' ``AsyncSubAgentMiddleware`` makes exactly six calls (threads
create/get, runs create/get/list/cancel); these models are their bodies and
answers, in the SDK's ``Thread`` / ``Run`` shapes (``langgraph_sdk.schema``).

Input is validated strictly where it matters and loosely where the SDK sends
defaults we do not use:

* identity is **never** read from a body — ``config``, ``context`` and
  ``metadata`` other than the sub-agent's name are accepted and ignored;
* a client-chosen ``thread_id``, a ``webhook`` (an outbound URL) and a
  ``command`` (an approval decision — the user's, never a model's) are refused;
* input messages are user messages with bounded text.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: One input message's text, at most (characters). A delegated task description
#: or follow-up; generous, but bounded.
MAX_INPUT_CHARS = 200_000
#: Messages one run's input may carry.
MAX_INPUT_MESSAGES = 20

ThreadStatus = Literal["idle", "busy", "interrupted", "error"]
RunStatus = Literal["pending", "running", "error", "success", "timeout", "interrupted"]
MultitaskStrategy = Literal["reject", "interrupt", "rollback", "enqueue"]


class ThreadMetadataIn(BaseModel):
    """The thread metadata deepagents sends: the sub-agent's name (and the
    caller's own thread, which is informational only)."""
    model_config = ConfigDict(extra="ignore")

    subagent_name: str = Field(min_length=1, max_length=200)
    parent_thread_id: str | None = Field(default=None, max_length=256)


class ThreadCreateIn(BaseModel):
    """``POST /ap/threads``."""
    model_config = ConfigDict(extra="ignore")

    thread_id: str | None = None
    metadata: ThreadMetadataIn
    if_exists: str | None = None

    @field_validator("thread_id")
    @classmethod
    def _no_client_ids(cls, value: str | None) -> str | None:
        # The task id is the thread id and the router mints it: a caller must
        # not be able to pick (or collide with) one.
        if value is not None:
            raise ValueError("thread_id is assigned by the server")
        return value


class InputMessage(BaseModel):
    """One message of a run's input: the task description or a follow-up."""
    model_config = ConfigDict(extra="ignore")

    role: Literal["user", "human"]
    content: str | list[dict[str, Any]]

    @field_validator("content")
    @classmethod
    def _bounded(cls, value: Any) -> Any:
        if isinstance(value, str):
            if len(value) > MAX_INPUT_CHARS:
                raise ValueError("message too long")
            return value
        text = 0
        for block in value:
            if block.get("type") != "text" or not isinstance(block.get("text"), str):
                raise ValueError("only text content is accepted")
            text += len(block["text"])
        if text > MAX_INPUT_CHARS:
            raise ValueError("message too long")
        return value

    def text(self) -> str:
        """The message's text."""
        if isinstance(self.content, str):
            return self.content
        return "".join(str(block.get("text") or "") for block in self.content)


class RunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[InputMessage] = Field(min_length=1, max_length=MAX_INPUT_MESSAGES)


class RunCreateIn(BaseModel):
    """``POST /ap/threads/{thread_id}/runs``."""
    model_config = ConfigDict(extra="ignore")

    assistant_id: str = Field(min_length=1, max_length=1024)
    input: RunInput | None = None
    command: dict[str, Any] | None = None
    multitask_strategy: MultitaskStrategy | None = None
    webhook: str | None = None
    # Sent by deepagents, never trusted: the launch token is the caller.
    config: dict[str, Any] | None = None
    context: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class ThreadOut(BaseModel):
    """A task as an Agent Protocol thread."""
    thread_id: str
    created_at: datetime
    updated_at: datetime
    metadata: dict[str, Any] = Field(default_factory=dict)
    status: ThreadStatus
    values: dict[str, Any] | None = None
    interrupts: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class RunOut(BaseModel):
    """A task run as an Agent Protocol run. ``error`` is a short, internals-free
    description (deepagents shows it to the parent's model)."""
    run_id: str
    thread_id: str
    assistant_id: str
    created_at: datetime
    updated_at: datetime
    status: RunStatus
    metadata: dict[str, Any] = Field(default_factory=dict)
    multitask_strategy: MultitaskStrategy | None = None
    kwargs: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


__all__ = [
    "MAX_INPUT_CHARS",
    "InputMessage",
    "MultitaskStrategy",
    "RunCreateIn",
    "RunInput",
    "RunOut",
    "RunStatus",
    "ThreadCreateIn",
    "ThreadMetadataIn",
    "ThreadOut",
    "ThreadStatus",
]
