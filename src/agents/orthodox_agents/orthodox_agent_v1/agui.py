import json
from uuid import uuid4
from typing import Any

from ag_ui.core import (
    EventType,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageChunkEvent,
    ThinkingTextMessageStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ThinkingStartEvent,
    ThinkingEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallChunkEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
)
from ag_ui.encoder import EventEncoder


class AGUIEmitter:
    """Stateless AG-UI emitter, pass `writer` and `message_id` each call."""

    def __init__(self) -> None:
        self._encoder = EventEncoder()

    def _emit(self, writer: Any, event_obj: object) -> None:
        sse = self._encoder.encode(event_obj)
        writer(sse)

    # ----------------------------- Public API ------------------------------
    # Thinking session boundaries
    def thinking_start(self, writer: Any, title: str | None = None) -> None:
        self._emit(writer, ThinkingStartEvent(type=EventType.THINKING_START, title=title))

    def thinking_end(self, writer: Any) -> None:
        self._emit(writer, ThinkingEndEvent(type=EventType.THINKING_END))

    # Thought content inside thinking session
    def thinking_text(self, writer: Any, content: str) -> None:
        self._emit(writer, ThinkingTextMessageStartEvent(type=EventType.THINKING_TEXT_MESSAGE_START))
        self._emit(writer, ThinkingTextMessageContentEvent(type=EventType.THINKING_TEXT_MESSAGE_CONTENT, delta=content))
        self._emit(writer, ThinkingTextMessageEndEvent(type=EventType.THINKING_TEXT_MESSAGE_END))

    # Assistant message streaming
    def text_start(self, writer: Any, message_id: str) -> None:
        self._emit(writer, TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=message_id))

    def text_chunk(self, writer: Any, delta: str) -> None:
        self._emit(writer, TextMessageChunkEvent(type=EventType.TEXT_MESSAGE_CHUNK, delta=delta))

    def text_content(self, writer: Any, delta: str) -> None:
        self._emit(writer, TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, delta=delta))

    def text_done(self, writer: Any, message_id: str) -> None:
        self._emit(writer, TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id))

    # Tool calls lifecycle
    def tool_call_start(self, writer: Any, parent_message_id: str, name: str, args: dict | None = None) -> str:
        tool_call_id = str(uuid4())
        self._emit(writer, ToolCallStartEvent(type=EventType.TOOL_CALL_START, parent_message_id=parent_message_id))
        args_text = json.dumps({"name": name, "args": args or {}}, ensure_ascii=False)
        self._emit(writer, ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, delta=args_text))
        return tool_call_id

    def tool_call_result(self, writer: Any, tool_call_id: str, output: str | dict) -> None:
        chunk_text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        self._emit(writer, ToolCallChunkEvent(type=EventType.TOOL_CALL_CHUNK, delta=chunk_text))
        self._emit(writer, ToolCallResultEvent(type=EventType.TOOL_CALL_RESULT, role="tool"))
        self._emit(writer, ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool_call_id))

    # Error as assistant message
    def error(self, writer: Any, message_id: str, message: str) -> None:
        self.text_start(writer, message_id)
        self.text_chunk(writer, f"Error: {message}")
        self.text_done(writer, message_id)

# Reusable emitter instance
agui_emitter = AGUIEmitter()
