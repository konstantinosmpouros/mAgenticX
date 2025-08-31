import json
from uuid import uuid4
from typing import Any

from ag_ui.core import (
    EventType,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ThinkingTextMessageStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallChunkEvent,
    ToolCallEndEvent,
)
from ag_ui.encoder import EventEncoder


class AGUIEmitter:
    """AG-UI event emitter wrapper for LangGraph writer using official types.

    Matches the common event types visible in the SDK:
    - TextMessageStart/Content/End
    - ThinkingTextMessageStart/Content/End
    - ToolCallStart/Args/Chunk/End
    """

    def __init__(self, writer: Any, message_id: str) -> None:
        self._writer = writer
        self._message_id = message_id
        self._encoder = EventEncoder()
        self._text_started = False
        self._last_tool_call_id: str | None = None

    def _emit(self, event_obj: object) -> None:
        sse = self._encoder.encode(event_obj)
        self._writer(sse)

    # ----------------------------- Public API ------------------------------
    # Thinking as a short burst: start -> content -> end
    def thought(self, content: str) -> None:
        self._emit(ThinkingTextMessageStartEvent(type=EventType.THINKING_TEXT_MESSAGE_START))
        self._emit(
            ThinkingTextMessageContentEvent(
                type=EventType.THINKING_TEXT_MESSAGE_CONTENT,
                delta=content,
            )
        )
        self._emit(ThinkingTextMessageEndEvent(type=EventType.THINKING_TEXT_MESSAGE_END))

    # Assistant message streaming
    def _ensure_text_started(self) -> None:
        if not self._text_started:
            self._emit(
                TextMessageStartEvent(
                    type=EventType.TEXT_MESSAGE_START,
                    message_id=self._message_id,
                )
            )
            self._text_started = True

    def text_delta(self, delta: str) -> None:
        self._ensure_text_started()
        self._emit(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=self._message_id,
                delta=delta,
            )
        )

    def text_done(self, _text: str | None = None) -> None:
        # Finalize the text message stream. The SDK's End event only needs message_id.
        self._emit(
            TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=self._message_id,
            )
        )
        self._text_started = False

    # Tool calls
    def tool_call(self, name: str, args: dict | None = None) -> None:
        # Start a tool call tied to this assistant message
        self._last_tool_call_id = str(uuid4())
        self._emit(
            ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                parent_message_id=self._message_id,
            )
        )
        # Send args as a chunk (delta)
        args_text = json.dumps({"name": name, "args": args or {}}, ensure_ascii=False)
        self._emit(
            ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                delta=args_text,
            )
        )

    def tool_result(self, name: str, output: str) -> None:
        # Stream the result as a tool chunk, then end the tool call
        chunk_text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        self._emit(
            ToolCallChunkEvent(
                type=EventType.TOOL_CALL_CHUNK,
                delta=chunk_text,
            )
        )
        self._emit(
            ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=self._last_tool_call_id or str(uuid4()),
            )
        )

    # Emit an error as a normal assistant message using SDK events
    def error(self, message: str) -> None:
        self._emit(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=self._message_id,
            )
        )
        self._emit(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=self._message_id,
                delta=f"Error: {message}",
            )
        )
        self._emit(
            TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=self._message_id,
            )
        )
