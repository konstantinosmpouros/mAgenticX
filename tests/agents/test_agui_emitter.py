import json

import pytest


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def _decode(frame: bytes) -> dict:
    """Parse the JSON payload out of an SSE `data:` frame produced by the emitter."""
    assert isinstance(frame, bytes), f"expected bytes, got {type(frame)}"
    text = frame.decode("utf-8")
    data_line = None
    for line in text.splitlines():
        if line.startswith("data:"):
            data_line = line[len("data:"):].lstrip()
            break
    assert data_line is not None, f"no data line in frame: {text!r}"
    return json.loads(data_line)


class _Writer:
    """Captures frames passed to a StreamWriter-style callable."""

    def __init__(self):
        self.frames = []

    def __call__(self, frame):
        self.frames.append(frame)


def _emitter(agents_service):
    return agents_service.emitter.AGUIEmitter()


# ----------------------------------------------------------------------
# Run lifecycle
# ----------------------------------------------------------------------
def test_run_start_returns_bytes(agents_service):
    frame = _emitter(agents_service).run_start(thread_id="t1", run_id="r1")
    assert isinstance(frame, bytes)
    assert b"RUN_STARTED" in frame
    payload = _decode(frame)
    assert payload["type"] == "RUN_STARTED"
    assert payload["threadId"] == "t1"
    assert payload["runId"] == "r1"
    assert "timestamp" in payload


def test_run_start_with_writer_returns_none(agents_service):
    writer = _Writer()
    result = _emitter(agents_service).run_start(thread_id="t1", run_id="r1", writer=writer)
    assert result is None
    assert len(writer.frames) == 1
    payload = _decode(writer.frames[0])
    assert payload["type"] == "RUN_STARTED"
    assert payload["threadId"] == "t1"


def test_run_end_returns_bytes(agents_service):
    frame = _emitter(agents_service).run_end(thread_id="t2", run_id="r2")
    payload = _decode(frame)
    assert payload["type"] == "RUN_FINISHED"
    assert payload["threadId"] == "t2"
    assert payload["runId"] == "r2"


def test_run_end_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).run_end(thread_id="t2", run_id="r2", writer=writer) is None
    assert _decode(writer.frames[0])["type"] == "RUN_FINISHED"


# ----------------------------------------------------------------------
# Thinking
# ----------------------------------------------------------------------
def test_thinking_start_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).thinking_start())
    assert payload["type"] == "THINKING_START"


def test_thinking_start_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).thinking_start(writer=writer) is None
    assert _decode(writer.frames[0])["type"] == "THINKING_START"


def test_thinking_end_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).thinking_end())
    assert payload["type"] == "THINKING_END"


def test_thinking_end_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).thinking_end(writer=writer) is None
    assert _decode(writer.frames[0])["type"] == "THINKING_END"


def test_thought_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).thought(content="pondering"))
    assert payload["type"] == "THINKING_TEXT_MESSAGE_CONTENT"
    assert payload["delta"] == "pondering"


def test_thought_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).thought(content="x", writer=writer) is None
    assert _decode(writer.frames[0])["delta"] == "x"


# ----------------------------------------------------------------------
# Response / text message streaming
# ----------------------------------------------------------------------
def test_response_start_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).response_start(message_id="m1"))
    assert payload["type"] == "TEXT_MESSAGE_START"
    assert payload["messageId"] == "m1"


def test_response_start_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).response_start(message_id="m1", writer=writer) is None
    assert _decode(writer.frames[0])["messageId"] == "m1"


def test_response_chunk_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).response_chunk(message_id="m1", delta="hel"))
    assert payload["type"] == "TEXT_MESSAGE_CHUNK"
    assert payload["messageId"] == "m1"
    assert payload["delta"] == "hel"


def test_response_chunk_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).response_chunk(message_id="m1", delta="lo", writer=writer) is None
    assert _decode(writer.frames[0])["delta"] == "lo"


def test_response_content_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).response_content(message_id="m2", delta="full"))
    assert payload["type"] == "TEXT_MESSAGE_CONTENT"
    assert payload["messageId"] == "m2"
    assert payload["delta"] == "full"


def test_response_content_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).response_content(message_id="m2", delta="full", writer=writer) is None
    assert _decode(writer.frames[0])["delta"] == "full"


def test_response_end_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).response_end(message_id="m3"))
    assert payload["type"] == "TEXT_MESSAGE_END"
    assert payload["messageId"] == "m3"


def test_response_end_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).response_end(message_id="m3", writer=writer) is None
    assert _decode(writer.frames[0])["messageId"] == "m3"


# ----------------------------------------------------------------------
# Tool calls
# ----------------------------------------------------------------------
def test_tool_call_start_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).tool_call_start(tool_call_id="tc1", name="search"))
    assert payload["type"] == "TOOL_CALL_START"
    assert payload["toolCallId"] == "tc1"
    assert payload["toolCallName"] == "search"


def test_tool_call_start_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).tool_call_start(tool_call_id="tc1", name="search", writer=writer) is None
    assert _decode(writer.frames[0])["toolCallName"] == "search"


def test_tool_call_args_with_dict(agents_service):
    payload = _decode(
        _emitter(agents_service).tool_call_args(tool_call_id="tc1", name="search", args={"q": "cats"})
    )
    assert payload["type"] == "TOOL_CALL_ARGS"
    assert payload["toolCallId"] == "tc1"
    inner = json.loads(payload["delta"])
    assert inner == {"name": "search", "args": {"q": "cats"}}


def test_tool_call_args_with_none_uses_empty_dict(agents_service):
    payload = _decode(
        _emitter(agents_service).tool_call_args(tool_call_id="tc1", name="search", args=None)
    )
    inner = json.loads(payload["delta"])
    assert inner == {"name": "search", "args": {}}


def test_tool_call_args_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).tool_call_args(
        tool_call_id="tc1", name="search", args={"q": "1"}, writer=writer
    ) is None
    inner = json.loads(_decode(writer.frames[0])["delta"])
    assert inner["args"] == {"q": "1"}


def test_tool_call_result_str_output(agents_service):
    payload = _decode(
        _emitter(agents_service).tool_call_result(tool_call_id="tc1", output="done")
    )
    assert payload["type"] == "TOOL_CALL_RESULT"
    assert payload["toolCallId"] == "tc1"
    assert payload["content"] == "done"
    # message_id falls back to tool_call_id when no thread_id is given
    assert payload["messageId"] == "tc1"


def test_tool_call_result_dict_output_is_json_serialized(agents_service):
    payload = _decode(
        _emitter(agents_service).tool_call_result(tool_call_id="tc1", output={"answer": 42})
    )
    assert json.loads(payload["content"]) == {"answer": 42}


def test_tool_call_result_with_thread_id_overrides_message_id(agents_service):
    payload = _decode(
        _emitter(agents_service).tool_call_result(tool_call_id="tc1", output="ok", thread_id="thread-X")
    )
    assert payload["messageId"] == "thread-X"
    assert payload["toolCallId"] == "tc1"


def test_tool_call_result_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).tool_call_result(
        tool_call_id="tc1", output="ok", writer=writer
    ) is None
    assert _decode(writer.frames[0])["content"] == "ok"


def test_tool_call_end_returns_bytes(agents_service):
    payload = _decode(_emitter(agents_service).tool_call_end(tool_call_id="tc1"))
    assert payload["type"] == "TOOL_CALL_END"
    assert payload["toolCallId"] == "tc1"


def test_tool_call_end_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).tool_call_end(tool_call_id="tc1", writer=writer) is None
    assert _decode(writer.frames[0])["toolCallId"] == "tc1"


# ----------------------------------------------------------------------
# Plan snapshot (custom event)
# ----------------------------------------------------------------------
def test_plan_snapshot_with_plan_items(agents_service):
    ev = agents_service.agui_events
    items = [
        ev.PlanItem(content="a", status="pending"),
        ev.PlanItem(content="b", status="completed"),
    ]
    frame = _emitter(agents_service).plan_snapshot(items, metadata={"plan": "main"})
    payload = _decode(frame)
    assert payload["type"] == "CUSTOM"
    assert payload["name"] == "PLAN_SNAPSHOT"
    value = payload["value"]
    assert value["metadata"] == {"plan": "main"}
    assert isinstance(value["updated_at"], int)
    assert [i["content"] for i in value["items"]] == ["a", "b"]


def test_plan_snapshot_with_dict_items_and_no_metadata(agents_service):
    frame = _emitter(agents_service).plan_snapshot(
        [{"content": "c", "status": "in_progress"}]
    )
    payload = _decode(frame)
    assert payload["value"]["metadata"] is None
    assert payload["value"]["items"][0]["status"] == "in_progress"


def test_plan_snapshot_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).plan_snapshot([], writer=writer) is None
    assert _decode(writer.frames[0])["name"] == "PLAN_SNAPSHOT"


# ----------------------------------------------------------------------
# Task -> sub-agent (custom event)
# ----------------------------------------------------------------------
def test_task_subagent_returns_bytes(agents_service):
    frame = _emitter(agents_service).task_subagent(
        task_id="task-1", subagent_type="researcher", description="dig"
    )
    payload = _decode(frame)
    assert payload["type"] == "CUSTOM"
    assert payload["name"] == "TASK_SUBAGENT"
    assert payload["value"] == {
        "task_id": "task-1",
        "subagent_type": "researcher",
        "description": "dig",
    }


def test_task_subagent_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).task_subagent(
        task_id="t", subagent_type="s", description="d", writer=writer
    ) is None
    assert _decode(writer.frames[0])["value"]["task_id"] == "t"


# ----------------------------------------------------------------------
# HITL interrupt (custom event)
# ----------------------------------------------------------------------
def test_hitl_interrupt_returns_bytes(agents_service):
    frame = _emitter(agents_service).hitl_interrupt(
        thread_id="thread-1",
        interrupt={"q": "approve?"},
        metadata={"node": "review"},
    )
    payload = _decode(frame)
    assert payload["type"] == "CUSTOM"
    assert payload["name"] == "HITL_INTERRUPT"
    assert payload["value"]["thread_id"] == "thread-1"
    assert payload["value"]["interrupt"] == {"q": "approve?"}
    assert payload["value"]["metadata"] == {"node": "review"}


def test_hitl_interrupt_metadata_defaults_to_empty_dict(agents_service):
    frame = _emitter(agents_service).hitl_interrupt(thread_id="t", interrupt="x")
    payload = _decode(frame)
    assert payload["value"]["metadata"] == {}


def test_hitl_interrupt_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).hitl_interrupt(
        thread_id="t", interrupt="x", writer=writer
    ) is None
    assert _decode(writer.frames[0])["name"] == "HITL_INTERRUPT"


# ----------------------------------------------------------------------
# Sub-agent envelope (custom event)
# ----------------------------------------------------------------------
def test_subagent_event_returns_bytes(agents_service):
    frame = _emitter(agents_service).subagent_event(
        task_id="task-9",
        subagent_namespace=["root", "child"],
        event={"type": "TEXT_MESSAGE_CHUNK", "delta": "hi"},
    )
    payload = _decode(frame)
    assert payload["type"] == "CUSTOM"
    assert payload["name"] == "SUBAGENT_EVENT"
    assert payload["value"]["task_id"] == "task-9"
    assert payload["value"]["namespace"] == ["root", "child"]
    assert payload["value"]["event"] == {"type": "TEXT_MESSAGE_CHUNK", "delta": "hi"}


def test_subagent_event_coerces_namespace_sequence(agents_service):
    frame = _emitter(agents_service).subagent_event(
        task_id="t",
        subagent_namespace=("a", "b"),
        event={},
    )
    assert _decode(frame)["value"]["namespace"] == ["a", "b"]


def test_subagent_event_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).subagent_event(
        task_id="t", subagent_namespace=["a"], event={}, writer=writer
    ) is None
    assert _decode(writer.frames[0])["name"] == "SUBAGENT_EVENT"


# ----------------------------------------------------------------------
# Before-agent (custom event)
# ----------------------------------------------------------------------
def test_before_agent_event_returns_bytes(agents_service):
    frame = _emitter(agents_service).before_agent_event(
        message="delegated work", metadata={"caller": "x"}
    )
    payload = _decode(frame)
    assert payload["type"] == "CUSTOM"
    assert payload["name"] == "BEFORE_AGENT_EVENT"
    assert payload["value"]["message"] == "delegated work"
    assert payload["value"]["metadata"] == {"caller": "x"}


def test_before_agent_event_metadata_defaults_to_empty_dict(agents_service):
    frame = _emitter(agents_service).before_agent_event(message="m")
    assert _decode(frame)["value"]["metadata"] == {}


def test_before_agent_event_with_writer(agents_service):
    writer = _Writer()
    assert _emitter(agents_service).before_agent_event(message="m", writer=writer) is None
    assert _decode(writer.frames[0])["value"]["message"] == "m"


# ----------------------------------------------------------------------
# _attach_namespace
# ----------------------------------------------------------------------
def test_namespace_injected_into_payload(agents_service):
    frame = _emitter(agents_service).run_start(thread_id="t1", run_id="r1", namespace="ns-1")
    payload = _decode(frame)
    assert payload["namespace"] == "ns-1"
    assert payload["type"] == "RUN_STARTED"


def test_namespace_injected_for_custom_event(agents_service):
    frame = _emitter(agents_service).before_agent_event(message="m", namespace="ns-2")
    payload = _decode(frame)
    assert payload["namespace"] == "ns-2"


def test_namespace_default_none_not_injected_as_value(agents_service):
    # When no namespace is passed the field is still injected (None) because
    # _attach_namespace always runs; verify it is present and null.
    frame = _emitter(agents_service).run_start(thread_id="t", run_id="r")
    payload = _decode(frame)
    assert payload.get("namespace", "MISSING") is None


def test_namespace_with_writer(agents_service):
    writer = _Writer()
    _emitter(agents_service).run_start(thread_id="t", run_id="r", writer=writer, namespace="nsw")
    assert _decode(writer.frames[0])["namespace"] == "nsw"


def test_attach_namespace_fallback_when_no_data_line(agents_service):
    emitter = _emitter(agents_service)
    # Encoder returns an SSE-like string with no `data:` line -> `applied` stays
    # False -> _attach_namespace returns the original bytes unchanged.
    emitter._encoder.encode = lambda event: "event: ping\n\n"
    frame = emitter.run_start(thread_id="t", run_id="r", namespace="ns")
    assert frame == b"event: ping\n\n"


def test_attach_namespace_fallback_on_invalid_json(agents_service):
    emitter = _emitter(agents_service)
    # `data:` present but body is not valid JSON -> json.loads raises ->
    # except branch returns the original (byte-coerced) sse.
    emitter._encoder.encode = lambda event: "data: not-json\n\n"
    frame = emitter.run_start(thread_id="t", run_id="r", namespace="ns")
    assert frame == b"data: not-json\n\n"


def test_attach_namespace_handles_str_encoder_output_coerced_to_bytes(agents_service):
    # The encoder already returns str; confirm _emit coerces to bytes and the
    # namespace path still produces valid bytes output.
    frame = _emitter(agents_service).thinking_start(namespace="ns")
    assert isinstance(frame, bytes)
    assert _decode(frame)["namespace"] == "ns"
