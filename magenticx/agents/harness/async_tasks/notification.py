"""The task notification message — the only place that knows its shape (plan 41 §3.5).

When a task settles, its parent learns it through a ``HumanMessage`` built the
way deepagents 0.7.34 builds it: content blocks under a "not from the user"
note and a ``<task-notification>`` header, plus notification metadata
(``lc_source="async_subagent"``, ``lc_data`` = the task event) and the
deprecated ``deepagents_notification`` key. The parent's
``AsyncSubAgentMiddleware`` reads that metadata to record the outcome, so the
same result is never reported twice (by a pull, a check, or another wake-up).

The helpers that build it are private upstream; wrapping them here keeps the
dependency in one module, pinned by a contract test against the real
middleware. Three consumers:

* the runner's internal wake of a task parent (the run's input);
* the outbox item for the bridge (``OutboxItem.notification``);
* the bridge's replay of a persisted notice row into a run's history
  (:func:`message_from_payload`).
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Literal

from deepagents.middleware.async_subagents import _event, _final_content, _notification_message
from langchain_core.messages import BaseMessage, HumanMessage

#: The keys a notification carries in ``additional_kwargs`` — nothing else from
#: a replayed payload is kept.
NOTIFICATION_KWARGS = frozenset({"lc_source", "lc_data", "deepagents_notification"})

#: The ``kind`` the bridge marks a persisted notice row with.
TASK_NOTIFICATION_KIND = "task_notification"

SettledStatus = Literal["success", "error", "cancelled"]


def final_content(messages: Sequence[Any]) -> list[dict[str, Any]]:
    """A task's result — its last message as standard content blocks."""
    return list(_final_content({"messages": list(messages)}))


def build_notification(
    *,
    task_id: str,
    agent_name: str,
    status: SettledStatus,
    run_id: str | None,
    result: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The notification for a settled task, as ``{"role", "content", "additional_kwargs"}``.

    ``agent_name`` must be the name the parent knows the sub-agent by, and
    ``run_id`` the task's latest run, so the parent's middleware matches it to
    the task it tracks. A failure carries no detail (it could hold internals);
    the parent reads ``check_async_task`` for the status.
    """
    details: dict[str, Any] = {}
    if status == "success":
        details["result"] = list(result or [{"type": "text", "text": "(completed with no output messages)"}])
    elif status == "error":
        details["error"] = "The subagent failed."
    return _notification_message(_event(task_id, agent_name, status, run_id, **details))


def notification_payload(message: Mapping[str, Any]) -> dict[str, Any]:
    """``OutboxItem.notification``: the content blocks and the metadata."""
    return {
        "content": message.get("content") or [],
        "additional_kwargs": {k: v for k, v in (message.get("additional_kwargs") or {}).items() if k in NOTIFICATION_KWARGS},
    }


def to_human_message(message: Mapping[str, Any]) -> HumanMessage:
    """A notification dict as the ``HumanMessage`` a run takes as input."""
    kwargs = {k: v for k, v in (message.get("additional_kwargs") or {}).items() if k in NOTIFICATION_KWARGS}
    return HumanMessage(content=message.get("content") or [], additional_kwargs=kwargs)


def is_notification_payload(message: Any) -> bool:
    """Whether a payload message is a persisted task-notification row."""
    return isinstance(message, Mapping) and message.get("kind") == TASK_NOTIFICATION_KIND


def message_from_payload(message: Mapping[str, Any]) -> BaseMessage:
    """A replayed notice row (``kind=task_notification``) as its ``HumanMessage``.

    The bridge persists the notification as a user-ish row and sends it back in
    a seed or delta. Kept as a human message *with* its metadata, so the
    middleware still recognises it; any other key of the row is dropped.
    """
    return to_human_message(message)


def normalize_payload_messages(messages: Sequence[Any]) -> list[Any]:
    """A run's input messages with every notice row turned into its ``HumanMessage``.

    Any other message passes through untouched (LangGraph converts the dicts).
    """
    return [message_from_payload(m) if is_notification_payload(m) else m for m in messages]


def text_preview(blocks: Sequence[Mapping[str, Any]], limit: int) -> str | None:
    """The text of a result, cut to ``limit`` characters, or ``None`` when it has none."""
    text = "".join(str(b.get("text") or "") for b in blocks if isinstance(b, Mapping) and b.get("type") == "text")
    text = text.strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1] + "…"


__all__ = [
    "NOTIFICATION_KWARGS",
    "TASK_NOTIFICATION_KIND",
    "build_notification",
    "final_content",
    "is_notification_payload",
    "message_from_payload",
    "normalize_payload_messages",
    "notification_payload",
    "text_preview",
    "to_human_message",
]
