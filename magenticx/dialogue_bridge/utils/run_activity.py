"""How much work an answer took, counted from its persisted event log.

One definition, used wherever the bridge needs it: ``_finish_run`` stamps the
counts on a new answer (``messages.model_calls`` / ``tool_calls``), and the
Usage tab's conversation page counts answers from before those columns existed.
It mirrors the UI's ``countRunActivity`` (``features/inference/timeline.ts``)
exactly, so the composer's context card and the Usage tab never disagree:

* a **model call** is one settled ``TOKEN_USAGE`` — deduplicated by the call's
  ``message_id``, as the run accumulator dedupes tokens;
* a **tool call** is one ``TOOL_CALL_START`` — deduplicated by ``toolCallId``;
* both count the main agent and every sub-agent (``SUBAGENT_EVENT`` wraps the
  latter), and legacy ``RAW_SSE_EVENT`` envelopes are unwrapped first.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RunActivity:
    model_calls: int
    tool_calls: int


def _parse_raw_sse(raw: Any) -> dict[str, Any] | None:
    """The event inside a legacy ``RAW_SSE_EVENT`` (``data: {...}``), if it parses."""
    text = str(raw or "")
    start = text.find("data:")
    if start == -1:
        return None
    payload = text[start + 5:]
    left, right = payload.find("{"), payload.rfind("}")
    if left == -1 or right < left:
        return None
    try:
        parsed = json.loads(payload[left:right + 1])
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def count_run_activity(events: Any) -> RunActivity:
    """Count an answer's model calls and tool calls from its raw event log."""
    usage_ids: set[str] = set()
    tool_ids: set[str] = set()
    anonymous_calls = 0
    anonymous_tools = 0

    # Iterative rather than recursive: a wrapped event is at most two levels
    # deep, but a stack keeps a malformed log from recursing without bound.
    stack: list[Any] = list(reversed(events)) if isinstance(events, list) else []
    while stack:
        event = stack.pop()
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if event_type == "RAW_SSE_EVENT":
            stack.append(_parse_raw_sse(event.get("raw_sse")))
        elif event_type == "TOOL_CALL_START":
            tool_id = event.get("toolCallId") or event.get("tool_call_id")
            if isinstance(tool_id, str) and tool_id:
                tool_ids.add(tool_id)
            else:
                anonymous_tools += 1
        elif event_type == "CUSTOM":
            value = event.get("value")
            if not isinstance(value, dict):
                continue
            if event.get("name") == "SUBAGENT_EVENT":
                stack.append(value.get("event"))
            elif event.get("name") == "TOKEN_USAGE":
                usage_id = value.get("message_id")
                if isinstance(usage_id, str) and usage_id:
                    usage_ids.add(usage_id)
                else:
                    anonymous_calls += 1

    return RunActivity(
        model_calls=len(usage_ids) + anonymous_calls,
        tool_calls=len(tool_ids) + anonymous_tools,
    )
