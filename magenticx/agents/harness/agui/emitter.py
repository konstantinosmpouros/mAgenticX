"""AG-UI events as JSON-ready dicts, and their SSE encoding.

Every method returns one event (``dict``; ``thought`` returns its three);
:func:`encode` turns one into its SSE frame, and :func:`send` writes events to a
LangGraph stream writer (:func:`is_agui_events` recognises events a node wrote
there unencoded). Events stay dicts until the edge, so the normalizer
can wrap a sub-agent's events without decoding them again.
"""

import json
import time
from collections.abc import Callable, Sequence
from typing import Any

from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    EventType,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageChunkEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ThinkingEndEvent,
    ThinkingStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ThinkingTextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from pydantic import BaseModel

from harness.agui.events import (
    BEFORE_AGENT_EVENT_TYPE,
    CHECKPOINT_COMMITTED_EVENT_TYPE,
    CONTEXT_COMPACTION_EVENT_TYPE,
    HITL_INTERRUPT_EVENT_TYPE,
    PLAN_SNAPSHOT_EVENT_TYPE,
    PRESENT_ARTIFACT_EVENT_TYPE,
    RENDER_CHART_EVENT_TYPE,
    SOURCES_EVENT_TYPE,
    SUBAGENT_COMPLETED_EVENT_TYPE,
    SUBAGENT_EVENT_TYPE,
    TASK_LAUNCHED_EVENT_TYPE,
    TASK_SETTLED_INLINE_EVENT_TYPE,
    TASK_SUBAGENT_EVENT_TYPE,
    TOKEN_USAGE_EVENT_TYPE,
    TOOL_USAGE_EVENT_TYPE,
    BeforeAgentEvent,
    CheckpointCommittedEvent,
    ContextCompactionEvent,
    HITLInterruptEvent,
    PlanItem,
    PlanSnapshot,
    PresentArtifactEvent,
    RenderChartEvent,
    SourcesEvent,
    SubAgentCompletedEvent,
    SubAgentEvent,
    TaskLaunchedEvent,
    TaskSettledInlineEvent,
    TaskSubAgentEvent,
    TokenUsageEvent,
    ToolUsageEvent,
)
from harness.agui.previews import shrink_image_blocks

#: One AG-UI event, ready for ``json.dumps``.
Event = dict[str, Any]

#: The call metrics ``UsageMetricsMiddleware`` / ``ModelTimingCallback`` stamp
#: that a ``TOKEN_USAGE`` event carries beside the token counts.
_TOKEN_USAGE_METRICS = (
    "model", "latency_ms", "context_window", "context_tokens", "context_percent",
    "compaction_percent", "finish_reason", "truncated", "ttft_ms",
)


def encode(event: Event) -> bytes:
    """The SSE frame of one event."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode()


#: Every AG-UI event type, to tell an emitter event from any other dict.
_EVENT_TYPES = {event_type.value for event_type in EventType}


def is_agui_events(value: Any) -> bool:
    """Whether ``value`` is an emitter event, or a non-empty list of them (a thought is three).

    A LangGraph node in ``custom`` stream mode may write emitter output to its
    stream writer as is; the agent's stream loop encodes it instead of handing
    it to the normalizer, which would take a dict for an ``updates`` payload
    and drop it.
    """
    events = value if isinstance(value, list) and value else [value]
    return all(isinstance(event, dict) and event.get("type") in _EVENT_TYPES for event in events)


def send(writer: Callable[[bytes], Any], events: Event | Sequence[Event]) -> None:
    """Write an event, or several in order, to a LangGraph stream writer as SSE frames.

    The ``custom`` stream mode forwards what a node writes verbatim, so a
    LangGraph agent's or workflow node's events reach the client exactly as a
    deep agent's normalized ones do.
    """
    for event in [events] if isinstance(events, dict) else events:
        writer(encode(event))


def _now_ms() -> int:
    return int(time.time() * 1000)


class AGUIEmitter:
    """Builds AG-UI events. Stateless; every event carries the actor's ``namespace``.

    A subclass that needs every event of a stream to carry the same context
    overrides :meth:`_extra_fields` (the workflow engine stamps its run
    envelope this way, ``harness/workflows/events.py``).
    """

    def event(self, event: BaseEvent, namespace: str | None = None) -> Event:
        """An ag_ui event as the wire dict (camelCase, no nulls), stamped and namespaced."""
        if event.timestamp is None:
            event.timestamp = _now_ms()
        return {
            **event.model_dump(mode="json", by_alias=True, exclude_none=True),
            "namespace": namespace,
            **self._extra_fields(),
        }

    def _extra_fields(self) -> dict[str, Any]:
        """Fields stamped onto every event beside ``namespace``: none here."""
        return {}

    def custom(self, name: str, value: BaseModel | dict[str, Any], namespace: str | None = None, **dump: Any) -> Event:
        """A CUSTOM event; ``dump`` goes to the value model's ``model_dump``."""
        if isinstance(value, BaseModel):
            value = value.model_dump(**dump)
        return self.event(CustomEvent(type=EventType.CUSTOM, name=name, value=value), namespace)

    # ---- run, thinking, text -------------------------------------------------
    def run_start(self, thread_id: str, run_id: str, namespace: str | None = None) -> Event:
        return self.event(RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id), namespace)

    def run_end(self, thread_id: str, run_id: str, namespace: str | None = None) -> Event:
        return self.event(RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id), namespace)

    def thinking_start(self, namespace: str | None = None) -> Event:
        return self.event(ThinkingStartEvent(type=EventType.THINKING_START), namespace)

    def thinking_end(self, namespace: str | None = None) -> Event:
        return self.event(ThinkingEndEvent(type=EventType.THINKING_END), namespace)

    def thought(self, content: str, namespace: str | None = None) -> list[Event]:
        """One complete thought: its thinking text message start, content and end."""
        return [
            self.event(ThinkingTextMessageStartEvent(type=EventType.THINKING_TEXT_MESSAGE_START), namespace),
            self.event(ThinkingTextMessageContentEvent(type=EventType.THINKING_TEXT_MESSAGE_CONTENT, delta=content), namespace),
            self.event(ThinkingTextMessageEndEvent(type=EventType.THINKING_TEXT_MESSAGE_END), namespace),
        ]

    def response_start(self, message_id: str, namespace: str | None = None) -> Event:
        return self.event(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=message_id), namespace)

    def response_chunk(self, message_id: str, delta: str, namespace: str | None = None) -> Event:
        return self.event(TextMessageChunkEvent(type=EventType.TEXT_MESSAGE_CHUNK, message_id=message_id, delta=delta), namespace)

    def response_content(self, message_id: str, delta: str, namespace: str | None = None) -> Event:
        return self.event(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=delta), namespace)

    def response_end(self, message_id: str, namespace: str | None = None) -> Event:
        return self.event(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id), namespace)

    # ---- tool calls ------------------------------------------------------------
    def tool_call_start(self, tool_call_id: str, name: str, namespace: str | None = None) -> Event:
        return self.event(
            ToolCallStartEvent(type=EventType.TOOL_CALL_START, tool_call_id=tool_call_id, tool_call_name=name), namespace,
        )

    def tool_call_args(self, tool_call_id: str, name: str, args: dict | str | None = None, namespace: str | None = None) -> Event:
        delta = json.dumps({"name": name, "args": args or {}}, ensure_ascii=False)
        return self.event(ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id=tool_call_id, delta=delta), namespace)

    def tool_call_result(
        self, tool_call_id: str, output: str | dict, *, thread_id: str | None = None, namespace: str | None = None,
        error: bool = False,
    ) -> Event:
        """The result; ``error`` rides as an extra field (the UI shows a failed step).

        Images are shrunk to a thumbnail for the stream only: ``output`` is the
        model's and is not touched (``harness/agui/previews.py``).
        """
        content = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        return self.event(ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            tool_call_id=tool_call_id,
            message_id=thread_id or tool_call_id,
            content=shrink_image_blocks(content),
            **({"error": True} if error else {}),
        ), namespace)

    def tool_call_end(self, tool_call_id: str, namespace: str | None = None) -> Event:
        return self.event(ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool_call_id), namespace)

    # ---- custom events -------------------------------------------------------------
    def plan_snapshot(self, items: Sequence[PlanItem | dict[str, Any]], *, metadata: dict[str, Any] | None = None,
                      namespace: str | None = None) -> Event:
        return self.custom(PLAN_SNAPSHOT_EVENT_TYPE, PlanSnapshot(items=list(items), updated_at=_now_ms(), metadata=metadata), namespace)

    def task_subagent(self, *, task_id: str, subagent_type: str, description: str, namespace: str | None = None) -> Event:
        payload = TaskSubAgentEvent(task_id=task_id, subagent_type=subagent_type, description=description)
        return self.custom(TASK_SUBAGENT_EVENT_TYPE, payload, namespace)

    def hitl_interrupt(self, thread_id: str, interrupt: Any, metadata: dict[str, Any] | None = None,
                       namespace: str | None = None) -> Event:
        payload = HITLInterruptEvent(thread_id=thread_id, interrupt=interrupt, metadata=metadata or {})
        return self.custom(HITL_INTERRUPT_EVENT_TYPE, payload, namespace)

    def subagent_event(self, *, task_id: str, subagent_namespace: Sequence[str], event: Event,
                       namespace: str | None = None) -> Event:
        """A sub-agent's event inside its `task` envelope."""
        payload = SubAgentEvent(task_id=task_id, namespace=list(subagent_namespace), event=event)
        return self.custom(SUBAGENT_EVENT_TYPE, payload, namespace)

    def subagent_completed(self, *, task_id: str, status: str = "completed", subagent_namespace: Sequence[str] | None = None,
                           started_at: int | None = None, ended_at: int | None = None, namespace: str | None = None) -> Event:
        """A delegated sub-agent returned: its card shows done/failed mid-run."""
        payload = SubAgentCompletedEvent(
            task_id=task_id, status="error" if status == "error" else "completed",
            namespace=list(subagent_namespace) if subagent_namespace else None, started_at=started_at, ended_at=ended_at,
        )
        return self.custom(SUBAGENT_COMPLETED_EVENT_TYPE, payload, namespace)

    def task_launched(self, *, task_id: str, name: str, description: str, action: str = "start",
                      namespace: str | None = None) -> Event:
        """A background task started (or updated). A start keeps the three-field shape."""
        payload = TaskLaunchedEvent(task_id=task_id, name=name, description=description, action=action)
        value = payload.model_dump(exclude_defaults=True) | {"name": name, "description": description}
        return self.custom(TASK_LAUNCHED_EVENT_TYPE, value, namespace)

    def task_settled_inline(self, *, task_id: str, name: str, status: str, namespace: str | None = None) -> Event:
        """A task's result was pulled into this busy run."""
        return self.custom(TASK_SETTLED_INLINE_EVENT_TYPE, TaskSettledInlineEvent(task_id=task_id, name=name, status=status), namespace)

    def before_agent_event(self, *, message: str, metadata: dict[str, Any] | None = None, namespace: str | None = None) -> Event:
        return self.custom(BEFORE_AGENT_EVENT_TYPE, BeforeAgentEvent(message=message, metadata=metadata or {}), namespace)

    def token_usage(self, usage_metadata: dict[str, Any], *, message_id: str | None = None, metrics: dict[str, Any] | None = None,
                    purpose: str | None = None, namespace: str | None = None) -> Event:
        """One model call's token usage, plus its metrics; ``purpose="compaction"`` marks a summary call."""
        metrics = metrics or {}
        payload = TokenUsageEvent(
            input_tokens=usage_metadata.get("input_tokens"),
            output_tokens=usage_metadata.get("output_tokens"),
            total_tokens=usage_metadata.get("total_tokens"),
            input_token_details=usage_metadata.get("input_token_details"),
            output_token_details=usage_metadata.get("output_token_details"),
            message_id=message_id,
            purpose="compaction" if purpose == "compaction" else None,
            **{name: metrics.get(name) for name in _TOKEN_USAGE_METRICS},
        )
        return self.custom(TOKEN_USAGE_EVENT_TYPE, payload, namespace, exclude_none=True)

    def tool_usage(self, *, tool_call_id: str, tool_name: str, duration_ms: int, status: str, output_chars: int,
                   namespace: str | None = None) -> Event:
        """One settled tool call's metrics (never its arguments or output)."""
        payload = ToolUsageEvent(
            tool_call_id=tool_call_id, tool_name=str(tool_name)[:200], duration_ms=duration_ms,
            status="error" if status == "error" else "ok", output_chars=output_chars,
        )
        return self.custom(TOOL_USAGE_EVENT_TYPE, payload, namespace)

    def sources(self, *, tool_call_id: str, sources: Sequence[Any], namespace: str | None = None) -> Event:
        """The citable pages one tool call returned (plan 42). ``sources`` are
        validated again here, so a malformed stamp raises ``ValidationError``."""
        payload = SourcesEvent(tool_call_id=tool_call_id, sources=list(sources))
        return self.custom(SOURCES_EVENT_TYPE, payload, namespace)

    def context_compaction(self, phase: str, *, details: dict[str, Any] | None = None, namespace: str | None = None) -> Event:
        """An automatic compaction's start, or its result (``details``)."""
        return self.custom(CONTEXT_COMPACTION_EVENT_TYPE, ContextCompactionEvent(phase=phase, **(details or {})), namespace,
                           exclude_none=True)

    def present_artifact(self, *, artifact_id: str, path: str, filename: str, title: str, summary: str | None = None,
                         mime: str | None = None, namespace: str | None = None) -> Event:
        """The card of a file the orchestrator presented (metadata only: the
        bridge fetches the bytes by ``path`` at finalize)."""
        payload = PresentArtifactEvent(
            artifact_id=artifact_id, path=path, filename=filename, title=title, summary=summary, mime=mime,
        )
        return self.custom(PRESENT_ARTIFACT_EVENT_TYPE, payload, namespace)

    def render_chart(self, *, chart_id: str, type: str, title: str, x_key: str, series: list, data: list,
                     subtitle: str | None = None, stacked: bool = False, horizontal: bool = False, show_values: bool = False,
                     namespace: str | None = None) -> Event:
        """A chart the orchestrator drew, whole (a chart has no bytes on disk to fetch later)."""
        payload = RenderChartEvent(
            chart_id=chart_id, type=type, title=title, subtitle=subtitle, x_key=x_key, series=series, data=data,
            stacked=stacked, horizontal=horizontal, show_values=show_values,
        )
        return self.custom(RENDER_CHART_EVENT_TYPE, payload, namespace)

    def checkpoint_committed(self, *, thread_id: str, checkpoint_id: str | None) -> Event:
        """The durable checkpoint head this run produced (terminal marker)."""
        return self.custom(CHECKPOINT_COMMITTED_EVENT_TYPE, CheckpointCommittedEvent(thread_id=thread_id, checkpoint_id=checkpoint_id))
