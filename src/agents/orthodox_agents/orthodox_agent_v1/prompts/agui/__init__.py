from typing import Any

from ag_ui.core import (
    EventType,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ThoughtEvent,
    ToolCallEvent,
    ToolResultEvent,
    ErrorEvent,
)
from ag_ui.encoder import EventEncoder


class AGUIEmitter:
    """AG-UI event emitter wrapper for LangGraph writer using official types."""

    def __init__(self, writer: Any, message_id: str) -> None:
        self._writer = writer
        self._message_id = message_id
        self._encoder = EventEncoder()

    def _emit(self, event_obj: object) -> None:
        sse = self._encoder.encode(event_obj)
        self._writer(sse)

    # ----------------------------- Public API ------------------------------
    def thought(self, content: str) -> None:
        self._emit(
            ThoughtEvent(
                type=EventType.THOUGHT,
                message_id=self._message_id,
                content=content,
            )
        )

    def text_delta(self, delta: str) -> None:
        self._emit(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=self._message_id,
                delta=delta,
            )
        )

    def text_done(self, text: str) -> None:
        self._emit(
            TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=self._message_id,
                text=text,
            )
        )

    def tool_call(self, name: str, args: dict | None = None) -> None:
        self._emit(
            ToolCallEvent(
                type=EventType.TOOL_CALL,
                message_id=self._message_id,
                name=name,
                args=args or {},
            )
        )

    def tool_result(self, name: str, output: str) -> None:
        self._emit(
            ToolResultEvent(
                type=EventType.TOOL_RESULT,
                message_id=self._message_id,
                name=name,
                output=output,
            )
        )

    def error(self, message: str) -> None:
        self._emit(
            ErrorEvent(
                type=EventType.ERROR,
                message_id=self._message_id,
                message=message,
            )
        )
