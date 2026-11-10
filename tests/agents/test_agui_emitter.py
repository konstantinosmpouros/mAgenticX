"""The AG-UI emitter: every method returns its event as a dict; ``encode`` makes
the SSE frame and ``send`` writes events to a LangGraph stream writer."""
import json



# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
_ENCODE = {}


def _decode(frame: dict | bytes) -> dict:
    """The JSON payload of an event's SSE frame: an event dict goes over the wire
    (``encode``) first, so every test checks what the client receives."""
    if isinstance(frame, dict):
        frame = _ENCODE["encode"](frame)
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
    _ENCODE["encode"] = agents_service.emitter.encode
    return agents_service.emitter.AGUIEmitter()


def _send(agents_service, writer, events):
    return agents_service.emitter.send(writer, events)


# ----------------------------------------------------------------------
# Run lifecycle
# ----------------------------------------------------------------------
def test_run_start_returns_an_event(agents_service):
    frame = _emitter(agents_service).run_start(thread_id="t1", run_id="r1")
    assert isinstance(frame, dict)
    assert frame["type"] == "RUN_STARTED"
    payload = _decode(frame)
    assert payload["type"] == "RUN_STARTED"
    assert payload["threadId"] == "t1"
    assert payload["runId"] == "r1"
    assert "timestamp" in payload


def test_run_start_with_writer_returns_none(agents_service):
    writer = _Writer()
    result = _send(agents_service, writer, _emitter(agents_service).run_start(thread_id="t1", run_id="r1"))
    assert result is None
    assert len(writer.frames) == 1
    payload = _decode(writer.frames[0])
    assert payload["type"] == "RUN_STARTED"
    assert payload["threadId"] == "t1"


def test_run_end_returns_an_event(agents_service):
    frame = _emitter(agents_service).run_end(thread_id="t2", run_id="r2")
    payload = _decode(frame)
    assert payload["type"] == "RUN_FINISHED"
    assert payload["threadId"] == "t2"
    assert payload["runId"] == "r2"


def test_run_end_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).run_end(thread_id="t2", run_id="r2")) is None
    assert _decode(writer.frames[0])["type"] == "RUN_FINISHED"


# ----------------------------------------------------------------------
# Thinking
# ----------------------------------------------------------------------
def test_thinking_start_returns_an_event(agents_service):
    payload = _decode(_emitter(agents_service).thinking_start())
    assert payload["type"] == "THINKING_START"


def test_thinking_start_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).thinking_start()) is None
    assert _decode(writer.frames[0])["type"] == "THINKING_START"


def test_thinking_end_returns_an_event(agents_service):
    payload = _decode(_emitter(agents_service).thinking_end())
    assert payload["type"] == "THINKING_END"


def test_thinking_end_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).thinking_end()) is None
    assert _decode(writer.frames[0])["type"] == "THINKING_END"


def test_thought_is_one_complete_thinking_text_message(agents_service):
    events = [_decode(e) for e in _emitter(agents_service).thought(content="pondering")]
    assert [e["type"] for e in events] == [
        "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_END",
    ]
    assert events[1]["delta"] == "pondering"


def test_thought_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).thought(content="x")) is None
    assert len(writer.frames) == 3
    assert _decode(writer.frames[1])["delta"] == "x"


# ----------------------------------------------------------------------
# Response / text message streaming
# ----------------------------------------------------------------------
def test_response_start_returns_an_event(agents_service):
    payload = _decode(_emitter(agents_service).response_start(message_id="m1"))
    assert payload["type"] == "TEXT_MESSAGE_START"
    assert payload["messageId"] == "m1"


def test_response_start_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).response_start(message_id="m1")) is None
    assert _decode(writer.frames[0])["messageId"] == "m1"


def test_response_chunk_returns_an_event(agents_service):
    payload = _decode(_emitter(agents_service).response_chunk(message_id="m1", delta="hel"))
    assert payload["type"] == "TEXT_MESSAGE_CHUNK"
    assert payload["messageId"] == "m1"
    assert payload["delta"] == "hel"


def test_response_chunk_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).response_chunk(message_id="m1", delta="lo")) is None
    assert _decode(writer.frames[0])["delta"] == "lo"


def test_response_content_returns_an_event(agents_service):
    payload = _decode(_emitter(agents_service).response_content(message_id="m2", delta="full"))
    assert payload["type"] == "TEXT_MESSAGE_CONTENT"
    assert payload["messageId"] == "m2"
    assert payload["delta"] == "full"


def test_response_content_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).response_content(message_id="m2", delta="full")) is None
    assert _decode(writer.frames[0])["delta"] == "full"


def test_response_end_returns_an_event(agents_service):
    payload = _decode(_emitter(agents_service).response_end(message_id="m3"))
    assert payload["type"] == "TEXT_MESSAGE_END"
    assert payload["messageId"] == "m3"


def test_response_end_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).response_end(message_id="m3")) is None
    assert _decode(writer.frames[0])["messageId"] == "m3"


# ----------------------------------------------------------------------
# Tool calls
# ----------------------------------------------------------------------
def test_tool_call_start_returns_an_event(agents_service):
    payload = _decode(_emitter(agents_service).tool_call_start(tool_call_id="tc1", name="search"))
    assert payload["type"] == "TOOL_CALL_START"
    assert payload["toolCallId"] == "tc1"
    assert payload["toolCallName"] == "search"


def test_tool_call_start_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).tool_call_start(tool_call_id="tc1", name="search")) is None
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
    assert _send(agents_service, writer, _emitter(agents_service).tool_call_args(
        tool_call_id="tc1", name="search", args={"q": "1"}
    )) is None
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
    assert _send(agents_service, writer, _emitter(agents_service).tool_call_result(
        tool_call_id="tc1", output="ok"
    )) is None
    assert _decode(writer.frames[0])["content"] == "ok"


def test_tool_call_end_returns_an_event(agents_service):
    payload = _decode(_emitter(agents_service).tool_call_end(tool_call_id="tc1"))
    assert payload["type"] == "TOOL_CALL_END"
    assert payload["toolCallId"] == "tc1"


def test_tool_call_end_with_writer(agents_service):
    writer = _Writer()
    assert _send(agents_service, writer, _emitter(agents_service).tool_call_end(tool_call_id="tc1")) is None
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
    assert _send(agents_service, writer, _emitter(agents_service).plan_snapshot([])) is None
    assert _decode(writer.frames[0])["name"] == "PLAN_SNAPSHOT"


# ----------------------------------------------------------------------
# Task -> sub-agent (custom event)
# ----------------------------------------------------------------------
def test_task_subagent_returns_an_event(agents_service):
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
    assert _send(agents_service, writer, _emitter(agents_service).task_subagent(
        task_id="t", subagent_type="s", description="d"
    )) is None
    assert _decode(writer.frames[0])["value"]["task_id"] == "t"


# ----------------------------------------------------------------------
# HITL interrupt (custom event)
# ----------------------------------------------------------------------
def test_hitl_interrupt_returns_an_event(agents_service):
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
    assert _send(agents_service, writer, _emitter(agents_service).hitl_interrupt(
        thread_id="t", interrupt="x"
    )) is None
    assert _decode(writer.frames[0])["name"] == "HITL_INTERRUPT"


# ----------------------------------------------------------------------
# Sub-agent envelope (custom event)
# ----------------------------------------------------------------------
def test_subagent_event_returns_an_event(agents_service):
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
    assert _send(agents_service, writer, _emitter(agents_service).subagent_event(
        task_id="t", subagent_namespace=["a"], event={}
    )) is None
    assert _decode(writer.frames[0])["name"] == "SUBAGENT_EVENT"


# ----------------------------------------------------------------------
# Before-agent (custom event)
# ----------------------------------------------------------------------
def test_before_agent_event_returns_an_event(agents_service):
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
    assert _send(agents_service, writer, _emitter(agents_service).before_agent_event(message="m")) is None
    assert _decode(writer.frames[0])["value"]["message"] == "m"


# ----------------------------------------------------------------------
# namespace and wire encoding
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
    # When no namespace is passed the field is still there, null.
    frame = _emitter(agents_service).run_start(thread_id="t", run_id="r")
    payload = _decode(frame)
    assert payload.get("namespace", "MISSING") is None


def test_namespace_with_writer(agents_service):
    writer = _Writer()
    _send(agents_service, writer, _emitter(agents_service).run_start(thread_id="t", run_id="r", namespace="nsw"))
    assert _decode(writer.frames[0])["namespace"] == "nsw"


def test_namespace_survives_encoding(agents_service):
    event = _emitter(agents_service).thinking_start(namespace="ns")
    frame = agents_service.emitter.encode(event)
    assert isinstance(frame, bytes) and frame.startswith(b"data: ") and frame.endswith(b"\n\n")
    assert _decode(frame)["namespace"] == "ns"


def test_encode_keeps_non_ascii_text(agents_service):
    frame = agents_service.emitter.encode(_emitter(agents_service).response_content(message_id="m", delta="Καλημέρα"))
    assert "Καλημέρα".encode() in frame


def test_is_agui_events_tells_emitter_events_from_other_values(agents_service):
    is_events = agents_service.emitter.is_agui_events
    emitter = _emitter(agents_service)
    assert is_events(emitter.thinking_start())
    assert is_events(emitter.thought("x"))
    assert not is_events([])
    assert not is_events({"agent": {"messages": []}})  # an "updates" payload
    assert not is_events({"type": "NOT_AN_EVENT"})
    assert not is_events([emitter.thinking_start(), {"agent": {}}])
    assert not is_events(b"data: {}\n\n")
