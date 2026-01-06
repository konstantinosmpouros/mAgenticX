import json
import time
from typing import Any, Dict, Optional, Sequence

from agui.events import (
    # Human-in-the-loop interrupt event
    HITL_INTERRUPT_EVENT_TYPE,
    HITLInterruptEvent,
    
    # Planning snapshot event
    PLAN_SNAPSHOT_EVENT_TYPE,
    PlanItem,
    PlanSnapshot,
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

    def _emit(self, event_obj: object, writer: Any = None) -> Optional[bytes]:
        """Encode and write an event object as SSE bytes, or return bytes when no writer is provided."""
        if getattr(event_obj, "timestamp", None) is None:
            event_obj.timestamp = int(time.time() * 1000)
        sse = self._encoder.encode(event_obj)
        if writer:
            writer(sse)
            return
        return sse


    # ---------- Run lifecycle ----------
    def run_start(self, thread_id: str, run_id: str, writer: Any = None) -> Optional[bytes]:
        return self._emit(RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id), writer)

    def run_end(self, thread_id: str, run_id: str, writer: Any = None) -> Optional[bytes]:
        return self._emit(RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id), writer)



    # ---------- Thinking session boundaries + content ----------
    def thinking_start(self, writer: Any = None) -> Optional[bytes]:
        return self._emit(ThinkingStartEvent(type=EventType.THINKING_START), writer)

    def thinking_end(self, writer: Any = None) -> Optional[bytes]:
        return self._emit(ThinkingEndEvent(type=EventType.THINKING_END), writer)

    def thought(self, content: str, writer: Any = None) -> Optional[bytes]:
        return self._emit(ThinkingTextMessageContentEvent(type=EventType.THINKING_TEXT_MESSAGE_CONTENT, delta=content), writer)



    # ---------- Agent message streaming ----------
    def response_start(self, message_id: str, writer: Any = None) -> Optional[bytes]:
        return self._emit(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=message_id), writer)

    def response_chunk(self, message_id: str, delta: str, writer: Any = None) -> Optional[bytes]:
        return self._emit(TextMessageChunkEvent(type=EventType.TEXT_MESSAGE_CHUNK, message_id=message_id, delta=delta), writer)

    def response_content(self, message_id: str, delta: str, writer: Any = None) -> Optional[bytes]:
        return self._emit(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=delta), writer)

    def response_end(self, message_id: str, writer: Any = None) -> Optional[bytes]:
        return self._emit(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id), writer)



    # ---------- Tool calls lifecycle ----------
    def tool_call_start(self, tool_call_id: str, parent_message_id: str, name: str, writer: Any = None) -> Optional[bytes]:
        # Tool Start
        tool_start = ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            tool_call_id=tool_call_id,
            tool_call_name=name,
            parent_message_id=parent_message_id
        )
        return self._emit(tool_start, writer)

    def tool_call_args(self, tool_call_id: str, name: str, args: dict | str | None = None, writer: Any = None) -> Optional[bytes]:
        # Tool Args
        tool_args = ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=tool_call_id,
            delta=json.dumps({"name": name, "args": args or {}}, ensure_ascii=False)
        )
        return self._emit(tool_args, writer)

    def tool_call_result(self, tool_call_id: str, parent_message_id: str, output: str | dict, writer: Any = None) -> Optional[bytes]:
        # Final result wrapper
        tool_results = ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            message_id=parent_message_id,
            tool_call_id=tool_call_id,
            content=output if isinstance(output, str) else json.dumps(output, ensure_ascii=False),
            role="tool"
        )
        return self._emit(tool_results, writer)

    def tool_call_end(self, tool_call_id: str, writer: Any = None) -> Optional[bytes]:
        return self._emit(ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool_call_id,), writer)



    # ---------- Planning snapshots (custom event) ----------
    def plan_snapshot(
        self,
        items: Sequence[PlanItem | Dict[str, Any]],
        *,
        metadata: Optional[Dict[str, Any]] = None,
        writer: Any = None,
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
        return self._emit(custom_event, writer)




    # ---------- Human-in-the-loop interrupt ----------
    def hitl_interrupt(
        self,
        thread_id: str,
        interrupt: Any,
        metadata: Optional[Dict[str, Any]] = None,
        writer: Any = None,
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
        return self._emit(custom_event, writer)
