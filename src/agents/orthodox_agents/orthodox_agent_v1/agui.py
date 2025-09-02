import json
import time
from typing import Any

from ag_ui.core import (
    EventType,
    
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



class AGUIEmitter:
    """Stateless AG-UI emitter compatible with LangGraph StreamWriter."""
    
    def __init__(self) -> None:
        self._encoder = EventEncoder()
    
    def _emit(self, writer: Any, event_obj: object) -> None:
        if getattr(event_obj, "timestamp", None) is None:
            event_obj.timestamp = int(time.time() * 1000)
        sse = self._encoder.encode(event_obj)
        writer(sse)
    
    
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
    
    
    # ---------- Error as assistant message ----------
    def error(self, writer: Any, message_id: str, message: str) -> None:
        self.response_start(writer, message_id)
        self.response_chunk(writer, message_id, f"Error: {message}")
        self.response_end(writer, message_id)

# Reusable emitter instance
agui_emitter = AGUIEmitter()
