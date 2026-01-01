import json
import time
from typing import Any, Dict, Optional, Mapping

from pydantic import BaseModel
from ag_ui.core import (
    EventType,
    BaseEvent,
    
    # General run events
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    
    # Text message events (assistant responses)
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageChunkEvent,
    
    # Thinking events
    ThinkingTextMessageStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ThinkingStartEvent,
    ThinkingEndEvent,
    
    # Tool-call events
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    
    # Safer metrics carrier
    CustomEvent,
)
from ag_ui.encoder import EventEncoder
from langgraph.checkpoint.serde.types import INTERRUPT



class AGUIEmitter:
    """Stateless AG-UI emitter compatible with LangGraph StreamWriter."""
    def __init__(self) -> None:
        self._encoder = EventEncoder()

    def _emit(self, writer: Any, event_obj: object) -> None:
        if getattr(event_obj, "timestamp", None) is None:
            event_obj.timestamp = int(time.time() * 1000)
        sse = self._encoder.encode(event_obj)
        writer(sse)

    def _emit_interrupt(
        self,
        chunk: Mapping[str, Any],
        thread_id: str,
        metadata: Optional[Dict[str, Any]] = None,
        writer: Any = None,
    ) -> bytes:
        """Extract interrupt payload from a LangGraph chunk and emit HITL event."""
        interrupt_payload = chunk.get(INTERRUPT)
        if isinstance(interrupt_payload, (list, tuple)) and interrupt_payload:
            interrupt_obj = interrupt_payload[0]
        else:
            interrupt_obj = interrupt_payload

        interrupt_id = getattr(interrupt_obj, "id", None) or getattr(interrupt_obj, "interrupt_id", None) or "unknown"
        interrupt_value = getattr(interrupt_obj, "value", interrupt_obj)

        meta = {"raw_interrupt": _json_safe(interrupt_payload)}
        if metadata:
            meta.update(metadata)

        return self.hitl_interrupt(
            thread_id=thread_id,
            interrupt_id=str(interrupt_id),
            value=_json_safe(interrupt_value),
            metadata=meta,
            writer=writer,
        )



    # ---------- Run lifecycle ----------
    def run_start(self, writer: Any, thread_id: str, run_id: str) -> None:
        self._emit(writer, RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id))

    def run_end(self, writer: Any, thread_id: str, run_id: str) -> None:
        self._emit(writer, RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id))



    # ---------- Thinking session boundaries + content ----------
    def thinking_start(self, writer: Any) -> None:
        self._emit(writer, ThinkingStartEvent(type=EventType.THINKING_START))

    def thinking_end(self, writer: Any) -> None:
        self._emit(writer, ThinkingEndEvent(type=EventType.THINKING_END))

    def thought(self, writer: Any, content: str) -> None:
        self._emit(writer, ThinkingTextMessageStartEvent(type=EventType.THINKING_TEXT_MESSAGE_START))
        self._emit(writer, ThinkingTextMessageContentEvent(type=EventType.THINKING_TEXT_MESSAGE_CONTENT, delta=content))
        self._emit(writer, ThinkingTextMessageEndEvent(type=EventType.THINKING_TEXT_MESSAGE_END))



    # ---------- Assistant message streaming ----------
    def response_start(self, writer: Any, message_id: str) -> None:
        self._emit(writer, TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=message_id))

    def response_chunk(self, writer: Any, message_id: str, delta: str) -> None:
        self._emit(writer, TextMessageChunkEvent(type=EventType.TEXT_MESSAGE_CHUNK, message_id=message_id, delta=delta))

    def response_content(self, writer: Any, message_id: str, delta: str) -> None:
        self._emit(writer, TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=delta))

    def response_end(self, writer: Any, message_id: str) -> None:
        self._emit(writer, TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id))



    # ---------- Tool calls lifecycle ----------
    def tool_call_start(self, writer: Any, tool_call_id: str, parent_message_id: str, name: str, args: dict | str | None = None) -> None:
        # Tool Start
        tool_start = ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            tool_call_id=tool_call_id,
            tool_call_name=name,
            parent_message_id=parent_message_id
        )
        self._emit(writer, tool_start)
        
        # Tool Args
        tool_args = ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=tool_call_id,
            delta=json.dumps({"name": name, "args": args or {}}, ensure_ascii=False)
        )
        self._emit(writer, tool_args)

    def tool_call_result(self, writer: Any, tool_call_id: str, parent_message_id: str, output: str | dict) -> None:
        # Final result wrapper
        tool_results = ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            message_id=parent_message_id,
            tool_call_id=tool_call_id,
            content=output if isinstance(output, str) else json.dumps(output, ensure_ascii=False),
            role="tool"
        )
        self._emit(writer, tool_results)
        
        # End
        self._emit(writer, ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool_call_id,))

    def tool_call_end(self, writer: Any, tool_call_id: str) -> None:
        self._emit(writer, ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool_call_id,))



    # ---------- Error as assistant message ----------
    def error(self, writer: Any, message_id: str, message: str) -> None:
        self.response_start(writer, message_id)
        self.response_chunk(writer, message_id, f"Error: {message}")
        self.response_end(writer, message_id)



    # ---------- Human-in-the-loop interrupt ----------
    def hitl_interrupt(
        self,
        thread_id: str,
        interrupt_id: str,
        value: Any,
        metadata: Optional[Dict[str, Any]] = None,
        writer: Any = None,
    ) -> bytes:
        """Emit a HITL interrupt event; returns the encoded SSE payload."""
        event = HITLInterruptEvent(
            type=HITL_INTERRUPT_EVENT_TYPE,
            thread_id=thread_id,
            interrupt={"id": interrupt_id, "value": value},
            metadata=metadata or {},
        )
        sse = self._encoder.encode(event)
        if writer:
            writer(sse)
        return sse



# ------------------------------------------------------------------
# HITL Interrupt Event
# ------------------------------------------------------------------
HITL_INTERRUPT_EVENT_TYPE = getattr(EventType, "HITL_INTERRUPT", "HITL_INTERRUPT")



class HITLInterruptEvent(BaseEvent, BaseModel):
    type: Any = HITL_INTERRUPT_EVENT_TYPE
    thread_id: str
    interrupt: Dict[str, Any]
    metadata: Optional[Dict[str, Any]] = None



def _json_safe(value: Any) -> Any:
    """Return a JSON-serializable value (fallback to string)."""
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)

