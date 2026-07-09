import json
import time
from typing import Any, Dict, Optional, Sequence

from runtime.agui.events import (
    # Human-in-the-loop interrupt event
    HITL_INTERRUPT_EVENT_TYPE,
    HITLInterruptEvent,
    
    # Planning snapshot event
    PLAN_SNAPSHOT_EVENT_TYPE,
    PlanItem,
    PlanSnapshot,
    
    # Task -> sub-agent assignment
    TASK_SUBAGENT_EVENT_TYPE,
    TaskSubAgentEvent,

    # Sub-agent envelope event
    SUBAGENT_EVENT_TYPE,
    SubAgentEvent,
    BEFORE_AGENT_EVENT_TYPE,
    BeforeAgentEvent,

    # Per-AI-message token usage
    TOKEN_USAGE_EVENT_TYPE,
    TokenUsageEvent,

    # Durable checkpoint head marker
    CHECKPOINT_COMMITTED_EVENT_TYPE,
    CheckpointCommittedEvent,

    # Agent-designated deliverable
    PRESENT_ARTIFACT_EVENT_TYPE,
    PresentArtifactEvent,
)
from ag_ui.core import (
    EventType,
    
    # General run events
    RunStartedEvent,
    RunFinishedEvent,
    
    # Text message events (assistant responses)
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageChunkEvent,
    
    # Thinking events
    ThinkingStartEvent,
    ThinkingEndEvent,
    ThinkingTextMessageContentEvent,
    
    # Tool-call events
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    
    # Safer metrics carrier
    CustomEvent
)
from ag_ui.encoder import EventEncoder



class AGUIEmitter:
    """Stateless AG-UI emitter compatible with LangGraph StreamWriter."""
    def __init__(self) -> None:
        self._encoder = EventEncoder()

    def _emit(self, event_obj: object, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        """Encode and write an event object as SSE bytes, or return bytes when no writer is provided."""
        if getattr(event_obj, "timestamp", None) is None:
            event_obj.timestamp = int(time.time() * 1000)
        sse = self._encoder.encode(event_obj)
        # Newer ag_ui versions return str; coerce so downstream stays bytes-clean.
        if isinstance(sse, str):
            sse = sse.encode("utf-8")
        sse = self._attach_namespace(sse, namespace)
        if writer:
            writer(sse)
            return
        return sse

    def _attach_namespace(self, sse: bytes, namespace: Optional[str]) -> bytes:
        """
        Inject a namespace field into the encoded SSE payload.
        Falls back to the original bytes on any parse/encode issue.
        """
        try:
            text = sse.decode("utf-8") if isinstance(sse, (bytes, bytearray)) else str(sse)
            lines = text.splitlines()

            new_lines = []
            applied = False
            for line in lines:
                if line.startswith("data:"):
                    payload_str = line[len("data:"):].lstrip()
                    payload = json.loads(payload_str)
                    payload["namespace"] = namespace
                    new_lines.append(f"data: {json.dumps(payload, ensure_ascii=False)}")
                    applied = True
                else:
                    new_lines.append(line)

            if not applied:
                return sse

            rebuilt = "\n".join(new_lines)
            if not rebuilt.endswith("\n"):
                rebuilt += "\n"
            if not rebuilt.endswith("\n\n"):
                rebuilt += "\n"

            return rebuilt.encode("utf-8")
        except Exception:
            return sse


    # ---------- Run lifecycle ----------
    def run_start(self, thread_id: str, run_id: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id), writer, namespace)

    def run_end(self, thread_id: str, run_id: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id), writer, namespace)



    # ---------- Thinking session boundaries + content ----------
    def thinking_start(self, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(ThinkingStartEvent(type=EventType.THINKING_START), writer, namespace)

    def thinking_end(self, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(ThinkingEndEvent(type=EventType.THINKING_END), writer, namespace)

    def thought(self, content: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(ThinkingTextMessageContentEvent(type=EventType.THINKING_TEXT_MESSAGE_CONTENT, delta=content), writer, namespace)



    # ---------- Agent message streaming ----------
    def response_start(self, message_id: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=message_id), writer, namespace)

    def response_chunk(self, message_id: str, delta: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(TextMessageChunkEvent(type=EventType.TEXT_MESSAGE_CHUNK, message_id=message_id, delta=delta), writer, namespace)

    def response_content(self, message_id: str, delta: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=delta), writer, namespace)

    def response_end(self, message_id: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id), writer, namespace)



    # ---------- Tool calls lifecycle ----------
    def tool_call_start(self, tool_call_id: str, name: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        # Tool Start
        tool_start = ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            tool_call_id=tool_call_id,
            tool_call_name=name,
        )
        return self._emit(tool_start, writer, namespace)

    def tool_call_args(self, tool_call_id: str, name: str, args: dict | str | None = None, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        # Tool Args
        tool_args = ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=tool_call_id,
            delta=json.dumps({"name": name, "args": args or {}}, ensure_ascii=False)
        )
        return self._emit(tool_args, writer, namespace)

    def tool_call_result(self, tool_call_id: str, output: str | dict, writer: Any = None, *, thread_id: Optional[str] = None, namespace: Optional[str] = None, error: bool = False) -> Optional[bytes]:
        # Final result wrapper. `error=True` rides as an extra field (the event
        # model allows extras) so the UI renders the tool step as failed.
        message_id = thread_id or tool_call_id
        tool_results = ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            tool_call_id=tool_call_id,
            message_id=message_id,
            content=output if isinstance(output, str) else json.dumps(output, ensure_ascii=False),
            **({"error": True} if error else {}),
        )
        return self._emit(tool_results, writer, namespace)

    def tool_call_end(self, tool_call_id: str, writer: Any = None, namespace: Optional[str] = None) -> Optional[bytes]:
        return self._emit(ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool_call_id,), writer, namespace)



    # ---------- Planning snapshots (custom event) ----------
    def plan_snapshot(
        self,
        items: Sequence[PlanItem | Dict[str, Any]],
        *,
        metadata: Optional[Dict[str, Any]] = None,
        writer: Any = None,
        namespace: Optional[str] = None,
    ) -> CustomEvent:
        """Create a plan snapshot custom event and optionally emit it."""
        snapshot = PlanSnapshot(
            items=list(items),
            updated_at=int(time.time() * 1000),
            metadata=metadata,
        )
        custom_event = CustomEvent(
            type=EventType.CUSTOM,
            name=PLAN_SNAPSHOT_EVENT_TYPE,
            value=snapshot.model_dump(),
        )
        return self._emit(custom_event, writer, namespace)



    # ---------- Task -> sub-agent assignment (custom event) ----------
    def task_subagent(
        self,
        *,
        task_id: str,
        subagent_type: str,
        description: str,
        writer: Any = None,
        namespace: Optional[str] = None,
    ) -> CustomEvent:
        """Create a task->sub-agent custom event and optionally emit it."""
        payload = TaskSubAgentEvent(
            task_id=task_id,
            subagent_type=subagent_type,
            description=description,
        )
        custom_event = CustomEvent(
            type=EventType.CUSTOM,
            name=TASK_SUBAGENT_EVENT_TYPE,
            value=payload.model_dump(),
        )
        return self._emit(custom_event, writer, namespace)



    # ---------- Human-in-the-loop interrupt ----------
    def hitl_interrupt(
        self,
        thread_id: str,
        interrupt: Any,
        metadata: Optional[Dict[str, Any]] = None,
        writer: Any = None,
        namespace: Optional[str] = None,
    ) -> CustomEvent:
        """Create a HITL interrupt custom event and optionally emit it."""
        payload = HITLInterruptEvent(
            thread_id=thread_id,
            interrupt=interrupt,
            metadata=metadata or {},
        )
        custom_event = CustomEvent(
            type=EventType.CUSTOM,
            name=HITL_INTERRUPT_EVENT_TYPE,
            value=payload.model_dump(),
        )
        return self._emit(custom_event, writer, namespace)


    # ---------- Sub-agent envelope ----------
    def subagent_event(
        self,
        *,
        task_id: str,
        subagent_namespace: Sequence[str],
        event: Dict[str, Any],
        writer: Any = None,
        namespace: Optional[str] = None,
    ) -> CustomEvent:
        """Wrap a normalized AG-UI event under a sub-agent task envelope."""
        payload = SubAgentEvent(
            task_id=task_id,
            namespace=list(subagent_namespace),
            event=event,
        )
        custom_event = CustomEvent(
            type=EventType.CUSTOM,
            name=SUBAGENT_EVENT_TYPE,
            value=payload.model_dump(),
        )
        return self._emit(custom_event, writer, namespace)


    # ---------- Before-agent event ----------
    def before_agent_event(
        self,
        *,
        message: str,
        metadata: Optional[Dict[str, Any]] = None,
        writer: Any = None,
        namespace: Optional[str] = None,
    ) -> CustomEvent:
        """Emit a before-agent custom event payload."""
        payload = BeforeAgentEvent(
            message=message,
            metadata=metadata or {},
        )
        custom_event = CustomEvent(
            type=EventType.CUSTOM,
            name=BEFORE_AGENT_EVENT_TYPE,
            value=payload.model_dump(),
        )
        return self._emit(custom_event, writer, namespace)


    # ---------- Token usage (custom event) ----------
    def token_usage(
        self,
        usage_metadata: Dict[str, Any],
        *,
        message_id: Optional[str] = None,
        writer: Any = None,
        namespace: Optional[str] = None,
    ) -> CustomEvent:
        """Emit per-AI-message token usage from ``AIMessage.usage_metadata``."""
        payload = TokenUsageEvent(
            input_tokens=usage_metadata.get("input_tokens"),
            output_tokens=usage_metadata.get("output_tokens"),
            total_tokens=usage_metadata.get("total_tokens"),
            input_token_details=usage_metadata.get("input_token_details"),
            output_token_details=usage_metadata.get("output_token_details"),
            message_id=message_id,
        )
        custom_event = CustomEvent(
            type=EventType.CUSTOM,
            name=TOKEN_USAGE_EVENT_TYPE,
            value=payload.model_dump(exclude_none=True),
        )
        return self._emit(custom_event, writer, namespace)


    # ---------- Present artifact (custom event) ----------
    def present_artifact(
        self,
        *,
        artifact_id: str,
        path: str,
        filename: str,
        title: str,
        summary: Optional[str] = None,
        mime: Optional[str] = None,
        writer: Any = None,
        namespace: Optional[str] = None,
    ) -> CustomEvent:
        """Create a present-artifact custom event and optionally emit it.

        Synthesized by the normalizer when the orchestrator calls the
        ``present_artifact`` tool — the tool itself never emits (deep agents
        don't stream the custom channel). Metadata-only: the bridge fetches the
        bytes by ``path`` at finalize.
        """
        payload = PresentArtifactEvent(
            artifact_id=artifact_id,
            path=path,
            filename=filename,
            title=title,
            summary=summary,
            mime=mime,
        )
        custom_event = CustomEvent(
            type=EventType.CUSTOM,
            name=PRESENT_ARTIFACT_EVENT_TYPE,
            value=payload.model_dump(),
        )
        return self._emit(custom_event, writer, namespace)


    # ---------- Durable checkpoint head (custom event) ----------
    def checkpoint_committed(
        self,
        *,
        thread_id: str,
        checkpoint_id: Optional[str],
        writer: Any = None,
    ) -> Optional[bytes]:
        """Emit the durable checkpoint head this run produced (terminal marker)."""
        payload = CheckpointCommittedEvent(thread_id=thread_id, checkpoint_id=checkpoint_id)
        custom_event = CustomEvent(
            type=EventType.CUSTOM,
            name=CHECKPOINT_COMMITTED_EVENT_TYPE,
            value=payload.model_dump(),
        )
        return self._emit(custom_event, writer, None)
