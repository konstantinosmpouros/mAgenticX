import json
import time
from typing import Any, Dict, Optional, Sequence

from runtime.protocols.agui.events import (
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
            text = sse.decode("utf-8")
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

    def tool_call_result(self, tool_call_id: str, output: str | dict, writer: Any = None, *, thread_id: Optional[str] = None, namespace: Optional[str] = None) -> Optional[bytes]:
        # Final result wrapper
        message_id = thread_id or tool_call_id
        tool_results = ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            tool_call_id=tool_call_id,
            message_id=message_id,
            content=output if isinstance(output, str) else json.dumps(output, ensure_ascii=False),
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
