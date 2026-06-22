from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage


def _norm(agents_service, thread_id="t-1"):
    return agents_service.normalizer.AGUIStreamNormalizer(thread_id=thread_id)


@pytest.fixture(autouse=True)
def _clear_namespace_bindings(agents_service):
    # Namespace->task bindings persist per thread_id across normalizer instances
    # (so a HITL resume keeps its mapping). Tests share thread_id="t-1", so clear
    # the module-global store around each test to keep them isolated.
    store = agents_service.normalizer._THREAD_NAMESPACE_BINDINGS
    store.clear()
    yield
    store.clear()


def _decode(frame):
    """Decode a single AG-UI SSE frame (bytes) into its JSON data payload dict."""
    if isinstance(frame, (bytes, bytearray)):
        text = frame.decode("utf-8")
    else:
        text = str(frame)
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[len("data:"):].lstrip())
    raise AssertionError(f"no data line in frame: {text!r}")


def _payloads(frames):
    return [_decode(f) for f in frames]


def _types(frames):
    return [p.get("type") for p in _payloads(frames)]


def _names(frames):
    """For CUSTOM events, return the 'name' field; else the 'type'."""
    out = []
    for p in _payloads(frames):
        if p.get("type") == "CUSTOM":
            out.append(p.get("name"))
        else:
            out.append(p.get("type"))
    return out


def _custom_value(frame):
    p = _decode(frame)
    assert p.get("type") == "CUSTOM"
    return p["name"], p["value"]


# ----------------------------------------------------------------------------
# envelope unwrapping
# ----------------------------------------------------------------------------
def test_unwrap_two_tuple_messages(agents_service):
    norm = _norm(agents_service)
    ns, mode, payload, meta = norm._unwrap_envelope(("messages", AIMessageChunk(content="hi")))
    assert ns is None
    assert mode == "messages"
    assert isinstance(payload, AIMessageChunk)
    assert meta is None


def test_unwrap_three_tuple_with_namespace(agents_service):
    norm = _norm(agents_service)
    chunk = (("tools:abc",), "messages", AIMessageChunk(content="hi"), {"langgraph_node": "model"})
    ns, mode, payload, meta = norm._unwrap_envelope(chunk)
    assert ns == ("tools:abc",)
    assert mode == "messages"
    assert payload.content == "hi"
    assert meta == {"langgraph_node": "model"}


def test_unwrap_namespace_as_list_coerced_to_tuple(agents_service):
    norm = _norm(agents_service)
    chunk = (["tools:abc"], "updates", {"node": {}})
    ns, mode, payload, meta = norm._unwrap_envelope(chunk)
    assert ns == ("tools:abc",)
    assert mode == "updates"


def test_unwrap_legacy_message_meta_tuple(agents_service):
    norm = _norm(agents_service)
    msg = AIMessageChunk(content="hi")
    chunk = ("messages", (msg, {"k": "v"}))
    ns, mode, payload, meta = norm._unwrap_envelope(chunk)
    assert mode == "messages"
    assert payload is msg
    assert meta == {"k": "v"}


def test_unwrap_legacy_message_meta_tuple_non_dict_meta(agents_service):
    norm = _norm(agents_service)
    msg = AIMessageChunk(content="hi")
    chunk = ("messages", (msg, "not-a-dict"))
    ns, mode, payload, meta = norm._unwrap_envelope(chunk)
    assert mode == "messages"
    assert payload is msg
    assert meta is None


def test_unwrap_dict_chunk_is_updates(agents_service):
    norm = _norm(agents_service)
    ns, mode, payload, meta = norm._unwrap_envelope({"some_node": {}})
    assert ns is None
    assert mode == "updates"
    assert payload == {"some_node": {}}


def test_unwrap_unknown_chunk(agents_service):
    norm = _norm(agents_service)
    ns, mode, payload, meta = norm._unwrap_envelope("just a string")
    assert ns is None
    assert mode is None
    assert payload == "just a string"


def test_unwrap_metadata_after_payload(agents_service):
    norm = _norm(agents_service)
    chunk = ("updates", {"n": {}}, {"meta": 1})
    ns, mode, payload, meta = norm._unwrap_envelope(chunk)
    assert mode == "updates"
    assert meta == {"meta": 1}


def test_handle_chunk_unknown_mode_returns_empty(agents_service):
    norm = _norm(agents_service)
    assert norm.handle_chunk("not a recognized chunk") == []


# ----------------------------------------------------------------------------
# messages mode — AI text deltas
# ----------------------------------------------------------------------------
def test_ai_message_chunk_first_delta_emits_start_then_chunk(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("messages", AIMessageChunk(content="Hello")))
    types = _types(out)
    assert types == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK"]
    # message_id is the thread_id
    start = _decode(out[0])
    assert start["messageId"] == "t-1"


def test_ai_message_chunk_second_delta_only_chunk(agents_service):
    norm = _norm(agents_service)
    norm.handle_chunk(("messages", AIMessageChunk(content="Hello")))
    out = norm.handle_chunk(("messages", AIMessageChunk(content=" world")))
    assert _types(out) == ["TEXT_MESSAGE_CHUNK"]
    chunk = _decode(out[0])
    assert chunk["delta"] == " world"


def test_ai_message_empty_delta_no_events(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("messages", AIMessageChunk(content="")))
    assert out == []


def test_ai_message_list_content_extracts_text(agents_service):
    norm = _norm(agents_service)
    content = [
        {"type": "text", "text": "foo"},
        {"type": "text", "text": "bar"},
        {"type": "image", "url": "ignored"},
        "not-a-dict",
    ]
    out = norm.handle_chunk(("messages", AIMessageChunk(content=content)))
    types = _types(out)
    assert types[-1] == "TEXT_MESSAGE_CHUNK"
    assert _decode(out[-1])["delta"] == "foobar"


def test_messages_other_kind_ignored(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("messages", HumanMessage(content="user text")))
    assert out == []


# ----------------------------------------------------------------------------
# messages mode — summarization suppression
#
# deepagents/langchain compresses history via an internal LLM call whose tokens
# stream on the messages channel tagged metadata.lc_source=="summarization". It
# must never render as the assistant's reply (the "SESSION INTENT/SUMMARY/..."
# leak). The normalizer drops any messages-mode chunk carrying that marker.
# ----------------------------------------------------------------------------
def test_summarization_ai_chunk_suppressed(agents_service):
    norm = _norm(agents_service)
    chunk = (
        "messages",
        AIMessageChunk(content="## SESSION INTENT\nSummarize the PDF."),
        {"langgraph_node": "model", "lc_source": "summarization"},
    )
    assert norm.handle_chunk(chunk) == []


def test_summarization_then_real_answer_only_emits_answer(agents_service):
    norm = _norm(agents_service)
    # internal summarization stream — suppressed
    norm.handle_chunk(
        ("messages", AIMessageChunk(content="## SUMMARY\nstuff"), {"lc_source": "summarization"})
    )
    # the real reply that follows — must still render, starting cleanly
    out = norm.handle_chunk(
        ("messages", AIMessageChunk(content="Here is the real answer."), {"langgraph_node": "model"})
    )
    assert _types(out) == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK"]
    assert _decode(out[-1])["delta"] == "Here is the real answer."


def test_summarization_suppressed_in_subagent_namespace(agents_service):
    norm = _norm(agents_service)
    chunk = (
        ("tools:sub-1",),
        "messages",
        AIMessageChunk(content="## NEXT STEPS\nkeep going"),
        {"langgraph_node": "model", "lc_source": "summarization"},
    )
    # Guard runs before sub-agent wrapping, so nothing is emitted/wrapped.
    assert norm.handle_chunk(chunk) == []


# ----------------------------------------------------------------------------
# messages mode — ToolMessage results
# ----------------------------------------------------------------------------
def test_tool_message_result_only_if_pending(agents_service):
    norm = _norm(agents_service)
    # tool_call_id not pending => nothing emitted
    tm = ToolMessage(content="result", tool_call_id="tc-1")
    out = norm.handle_chunk(("messages", tm))
    assert out == []


def test_tool_message_result_emits_after_started(agents_service):
    norm = _norm(agents_service)
    # Start a tool through updates first
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "tc-1", "name": "search", "args": {"q": "x"}}],
    )
    start_out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert _names(start_out) == ["TOOL_CALL_START", "TOOL_CALL_ARGS"]

    tm = ToolMessage(content="the answer", tool_call_id="tc-1")
    out = norm.handle_chunk(("messages", tm))
    assert _types(out) == ["TOOL_CALL_RESULT", "TOOL_CALL_END"]
    res = _decode(out[0])
    assert res["content"] == "the answer"


def test_tool_message_result_deduped_after_finished(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "tc-1", "name": "search", "args": {}}])
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    tm = ToolMessage(content="x", tool_call_id="tc-1")
    norm.handle_chunk(("messages", tm))
    # second time => already finished => no events
    out = norm.handle_chunk(("messages", tm))
    assert out == []


def test_tool_message_no_tool_call_id_ignored(agents_service):
    norm = _norm(agents_service)
    tm = ToolMessage(content="x", tool_call_id="")
    out = norm.handle_chunk(("messages", tm))
    assert out == []


def test_tool_message_ignored_id_discarded(agents_service):
    norm = _norm(agents_service)
    # write_todos marks the id ignored
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "wt-1", "name": "write_todos", "args": {"todos": [{"content": "a", "status": "pending"}]}}],
    )
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert "wt-1" in norm._ignored_tool_call_ids
    tm = ToolMessage(content="ignored", tool_call_id="wt-1")
    out = norm.handle_chunk(("messages", tm))
    assert out == []
    # discarded from the ignored set
    assert "wt-1" not in norm._ignored_tool_call_ids


# ----------------------------------------------------------------------------
# updates mode — tool calls
# ----------------------------------------------------------------------------
def test_updates_non_dict_payload_returns_empty(agents_service):
    norm = _norm(agents_service)
    out = norm._handle_updates_payload(["not", "a", "dict"])
    assert out == []


def test_updates_node_value_none_or_non_dict_skipped(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("updates", {"node_a": None, "node_b": "string"}))
    assert out == []


def test_updates_normal_tool_emits_start_args(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "tc-9", "name": "calc", "args": {"a": 1}}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert _names(out) == ["TOOL_CALL_START", "TOOL_CALL_ARGS"]
    args = _decode(out[1])
    assert json.loads(args["delta"]) == {"name": "calc", "args": {"a": 1}}
    assert "tc-9" in norm._pending_tool_call_ids
    assert "tc-9" in norm._started_tool_call_ids


def test_updates_normal_tool_deduped_when_already_started(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "tc-9", "name": "calc", "args": {}}])
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert out == []


# ----------------------------------------------------------------------------
# updates mode — write_todos / plan snapshot dedup
# ----------------------------------------------------------------------------
def test_updates_write_todos_emits_plan_snapshot(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "step1", "status": "pending"}]
    ai = AIMessage(content="", tool_calls=[{"id": "wt-1", "name": "write_todos", "args": {"todos": todos}}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert _names(out) == ["PLAN_SNAPSHOT"]
    name, value = _custom_value(out[0])
    assert [{"content": i["content"], "status": i["status"]} for i in value["items"]] == todos
    assert "wt-1" in norm._ignored_tool_call_ids


def test_updates_write_todos_dedup_same_fingerprint(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "step1", "status": "pending"}]
    ai = AIMessage(content="", tool_calls=[{"id": "wt-1", "name": "write_todos", "args": {"todos": todos}}])
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    ai2 = AIMessage(content="", tool_calls=[{"id": "wt-2", "name": "write_todos", "args": {"todos": todos}}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai2]}}))
    # same fingerprint => no plan snapshot re-emitted
    assert out == []


def test_updates_write_todos_non_list_args_ignored(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "wt-1", "name": "write_todos", "args": {"todos": "not-a-list"}}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert out == []
    assert "wt-1" in norm._ignored_tool_call_ids


def test_updates_authoritative_todos_snapshot(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "do it", "status": "in_progress"}]
    out = norm.handle_chunk(("updates", {"some_node": {"todos": todos}}))
    assert _names(out) == ["PLAN_SNAPSHOT"]
    name, value = _custom_value(out[0])
    assert [{"content": i["content"], "status": i["status"]} for i in value["items"]] == todos


def test_updates_metadata_forwarded_into_plan_snapshot(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "metafwd", "status": "pending"}]
    # non-HITL updates chunk WITH a metadata dict => meta.update(metadata) runs
    out = norm.handle_chunk(("updates", {"some_node": {"todos": todos}}, {"run_id": "r-42"}))
    assert _names(out) == ["PLAN_SNAPSHOT"]
    name, value = _custom_value(out[0])
    assert value["metadata"]["run_id"] == "r-42"
    assert value["metadata"]["namespace"] is None


def test_updates_authoritative_todos_dedup(agents_service):
    norm = _norm(agents_service)
    todos = [{"content": "do it", "status": "in_progress"}]
    norm.handle_chunk(("updates", {"some_node": {"todos": todos}}))
    out = norm.handle_chunk(("updates", {"some_node": {"todos": todos}}))
    assert out == []


# ----------------------------------------------------------------------------
# updates mode — task subagent dedup
# ----------------------------------------------------------------------------
def test_updates_task_emits_subagent_event(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "task-1", "name": "task", "args": {"subagent_type": "researcher", "description": "find x"}}],
    )
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert _names(out) == ["TASK_SUBAGENT"]
    name, value = _custom_value(out[0])
    assert value["task_id"] == "task-1"
    assert value["subagent_type"] == "researcher"
    assert value["description"] == "find x"
    assert "task-1" in norm._emitted_subagent_task_ids
    assert "task-1" in norm._ignored_tool_call_ids
    assert norm._pending_tasks["task-1"]["description"] == "find x"


def test_updates_task_deduped(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "task-1", "name": "task", "args": {"subagent_type": "r", "description": "d"}}],
    )
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert out == []


class _FakeAI:
    """Minimal AI-like message; bypasses langchain's strict tool_call validation."""

    type = "ai"

    def __init__(self, content="", tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls or []
        self.additional_kwargs = {}


def test_updates_task_non_dict_args_still_ignored(agents_service):
    norm = _norm(agents_service)
    # args None => not a dict => no subagent event but id marked ignored
    ai = _FakeAI(tool_calls=[{"id": "task-2", "name": "task", "args": None}])
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert out == []
    assert "task-2" in norm._ignored_tool_call_ids


# ----------------------------------------------------------------------------
# updates mode — final AI content synthesis
# ----------------------------------------------------------------------------
def test_updates_final_ai_content_updates_only(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="final answer", id="m-1")
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    # no prior messages chunk => synthesize start/content/end
    assert _types(out) == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]


def test_updates_final_ai_content_after_messages_chunk_only_closes(agents_service):
    norm = _norm(agents_service)
    # first a messages chunk
    norm.handle_chunk(("messages", AIMessageChunk(content="streamed")))
    ai = AIMessage(content="streamed final")
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    # response already started + saw_messages_chunk => only END
    assert _types(out) == ["TEXT_MESSAGE_END"]


def test_updates_ai_no_content_no_text_events(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="")
    out = norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert out == []


def test_updates_tool_message_result_path(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "tc-5", "name": "lookup", "args": {}}])
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    tm = ToolMessage(content="done", tool_call_id="tc-5")
    out = norm.handle_chunk(("updates", {"tools": {"messages": [tm]}}))
    assert _types(out) == ["TOOL_CALL_RESULT", "TOOL_CALL_END"]


def test_updates_non_ai_non_tool_message_skipped(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("updates", {"agent": {"messages": [HumanMessage(content="hi")]}}))
    assert out == []


# ----------------------------------------------------------------------------
# updates mode — HITL interrupt priority
# ----------------------------------------------------------------------------
class _FakeInterrupt:
    def __init__(self, id, value):
        self.id = id
        self.value = value


def test_hitl_interrupt_with_object(agents_service):
    norm = _norm(agents_service)
    interrupt = _FakeInterrupt("int-1", {"question": "approve?"})
    out = norm.handle_chunk(("updates", {"__interrupt__": [interrupt]}))
    assert _names(out) == ["HITL_INTERRUPT"]
    name, value = _custom_value(out[0])
    assert value["interrupt"]["id"] == "int-1"
    assert value["interrupt"]["value"] == {"question": "approve?"}


def test_hitl_interrupt_with_metadata(agents_service):
    norm = _norm(agents_service)
    interrupt = _FakeInterrupt("int-2", "val")
    out = norm.handle_chunk(("updates", {"__interrupt__": [interrupt]}, {"run_id": "r-1"}))
    name, value = _custom_value(out[0])
    assert value["metadata"]["run_id"] == "r-1"
    assert "namespace" in value["metadata"]


def test_hitl_interrupt_empty_list_payload(agents_service):
    norm = _norm(agents_service)
    # __interrupt__ present but empty list => raw is falsy => interrupt_obj is the [] itself
    out = norm.handle_chunk(("updates", {"__interrupt__": []}))
    assert _names(out) == ["HITL_INTERRUPT"]
    name, value = _custom_value(out[0])
    # [] has no .id and no .value => id None, value falls back to the object ([])
    assert value["interrupt"] == {"id": None, "value": []}


def test_hitl_interrupt_explicit_none(agents_service):
    norm = _norm(agents_service)
    # __interrupt__ explicitly None => interrupt_obj is None => payload stays None
    out = norm.handle_chunk(("updates", {"__interrupt__": None}))
    assert _names(out) == ["HITL_INTERRUPT"]
    name, value = _custom_value(out[0])
    assert value["interrupt"] is None


def test_hitl_interrupt_bare_object_not_list(agents_service):
    norm = _norm(agents_service)
    interrupt = _FakeInterrupt("int-3", "v")
    out = norm.handle_chunk(("updates", {"__interrupt__": interrupt}))
    name, value = _custom_value(out[0])
    assert value["interrupt"]["id"] == "int-3"


# ----------------------------------------------------------------------------
# updates mode — before_agent event
# ----------------------------------------------------------------------------
def test_before_agent_marker_binds_namespace_to_pending_task(agents_service):
    norm = _norm(agents_service)
    # Register a pending task via a task tool call (orchestrator namespace).
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "task-7", "name": "task", "args": {"subagent_type": "r", "description": "go research"}}],
    )
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert "task-7" in norm._pending_tasks

    # deepagents 0.6.10 emits the before_agent marker with a NULL body, stamped
    # with the subagent namespace. We bind on namespace + FIFO, not on content.
    payload = {"PatchToolCallsMiddleware.before_agent": None}
    out = norm.handle_chunk((("tools:abc",), "updates", payload))

    # Marker wrapped as a subagent event, keyed by the bound task tool_call_id.
    assert _names(out) == ["SUBAGENT_EVENT"]
    name, value = _custom_value(out[0])
    assert value["task_id"] == "task-7"
    assert value["event"]["name"] == "BEFORE_AGENT_EVENT"
    # Namespace is now bound to the task id; pending task consumed.
    assert norm._namespace_task_labels[("tools:abc",)] == "task-7"
    assert "task-7" not in norm._pending_tasks


def test_before_agent_marker_no_namespace_skipped(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("updates", {"PatchToolCallsMiddleware.before_agent": None}))
    assert out == []


def test_before_agent_marker_no_pending_task_emits_nothing(agents_service):
    norm = _norm(agents_service)
    # No pending task to bind => no BEFORE_AGENT_EVENT, namespace stays unbound.
    out = norm.handle_chunk((("tools:abc",), "updates", {"PatchToolCallsMiddleware.before_agent": None}))
    assert out == []
    assert ("tools:abc",) not in norm._namespace_task_labels


# ----------------------------------------------------------------------------
# sub-agent namespace wrapping
# ----------------------------------------------------------------------------
def test_subagent_namespace_wraps_text_events(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(((("tools:task-77"),), "messages", AIMessageChunk(content="sub text")))
    # every event wrapped as SUBAGENT_EVENT
    assert all(_decode(f)["type"] == "CUSTOM" for f in out)
    assert all(_decode(f)["name"] == "SUBAGENT_EVENT" for f in out)
    name, value = _custom_value(out[0])
    assert value["task_id"] == "task-77"
    assert value["namespace"] == ["tools:task-77"]
    # inner event is the original TEXT_MESSAGE_START
    assert value["event"]["type"] == "TEXT_MESSAGE_START"


def test_orchestrator_events_not_wrapped(agents_service):
    norm = _norm(agents_service)
    out = norm.handle_chunk(("messages", AIMessageChunk(content="hi")))
    assert _decode(out[0])["type"] == "TEXT_MESSAGE_START"


def test_subagent_empty_namespace_not_wrapped(agents_service):
    norm = _norm(agents_service)
    # empty tuple namespace => no task id => pass through
    out = norm.handle_chunk(((), "messages", AIMessageChunk(content="hi")))
    assert _decode(out[0])["type"] == "TEXT_MESSAGE_START"


# ----------------------------------------------------------------------------
# pure helpers — _extract_text_delta
# ----------------------------------------------------------------------------
def test_extract_text_delta_str(agents_service):
    norm = _norm(agents_service)
    assert norm._extract_text_delta(AIMessageChunk(content="abc")) == "abc"


def test_extract_text_delta_list(agents_service):
    norm = _norm(agents_service)
    msg = AIMessageChunk(content=[{"type": "text", "text": "a"}, {"text": "b"}, {"foo": "bar"}])
    assert norm._extract_text_delta(msg) == "ab"


def test_extract_text_delta_other_type(agents_service):
    norm = _norm(agents_service)

    class _M:
        content = 12345

    assert norm._extract_text_delta(_M()) == ""


def test_extract_text_delta_missing_content(agents_service):
    norm = _norm(agents_service)

    class _M:
        pass

    assert norm._extract_text_delta(_M()) == ""


# ----------------------------------------------------------------------------
# pure helpers — _iter_tool_calls
# ----------------------------------------------------------------------------
def test_iter_tool_calls_dict_shape(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(content="", tool_calls=[{"id": "a", "name": "n", "args": {"x": 1}}])
    calls = norm._iter_tool_calls(ai)
    assert calls == [{"id": "a", "name": "n", "args": {"x": 1}}]


def test_iter_tool_calls_object_shape(agents_service):
    norm = _norm(agents_service)

    class _TC:
        id = "a"
        name = "n"
        args = {"x": 1}

    class _Msg:
        tool_calls = [_TC()]

    calls = norm._iter_tool_calls(_Msg())
    assert calls == [{"id": "a", "name": "n", "args": {"x": 1}}]


def test_iter_tool_calls_additional_kwargs_fallback(agents_service):
    norm = _norm(agents_service)

    class _Msg:
        tool_calls = None
        additional_kwargs = {"tool_calls": [{"id": "a", "name": "n", "args": {}}]}

    calls = norm._iter_tool_calls(_Msg())
    assert calls == [{"id": "a", "name": "n", "args": {}}]


def test_iter_tool_calls_none(agents_service):
    norm = _norm(agents_service)

    class _Msg:
        tool_calls = None
        additional_kwargs = {}

    assert norm._iter_tool_calls(_Msg()) == []


def test_iter_tool_calls_filters_missing_id_or_name(agents_service):
    norm = _norm(agents_service)
    ai = _FakeAI(
        tool_calls=[
            {"id": None, "name": "n", "args": {}},
            {"id": "a", "name": None, "args": {}},
            {"id": "b", "name": "ok", "args": {}},
        ],
    )
    calls = norm._iter_tool_calls(ai)
    assert calls == [{"id": "b", "name": "ok", "args": {}}]


# ----------------------------------------------------------------------------
# pure helpers — _unwrap_messages_list
# ----------------------------------------------------------------------------
def test_unwrap_messages_list_none(agents_service):
    norm = _norm(agents_service)
    assert norm._unwrap_messages_list(None) == []


def test_unwrap_messages_list_overwrite_value(agents_service):
    norm = _norm(agents_service)

    class _Overwrite:
        value = ["m1", "m2"]

    assert norm._unwrap_messages_list(_Overwrite()) == ["m1", "m2"]


def test_unwrap_messages_list_plain_list(agents_service):
    norm = _norm(agents_service)
    assert norm._unwrap_messages_list(["a", "b"]) == ["a", "b"]


def test_unwrap_messages_list_single_message(agents_service):
    norm = _norm(agents_service)
    m = HumanMessage(content="x")
    assert norm._unwrap_messages_list(m) == [m]


# ----------------------------------------------------------------------------
# pure helpers — namespace derivation
# ----------------------------------------------------------------------------
def test_namespace_task_id_colon(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_task_id(("tools:abc-123",)) == "abc-123"


def test_namespace_task_id_no_colon(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_task_id(("plainpart",)) == "plainpart"


def test_namespace_task_id_colon_empty_tail(agents_service):
    norm = _norm(agents_service)
    # "tools:" => tail empty => returns the original part
    assert norm._namespace_task_id(("tools:",)) == "tools:"


def test_namespace_task_id_none(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_task_id(None) is None


def test_namespace_task_id_empty_tuple(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_task_id(()) is None


def test_namespace_task_id_skips_empty_parts(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_task_id(("", None, "tools:zzz")) == "zzz"


def test_namespace_task_id_all_empty_parts(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_task_id(("", None)) is None


def test_namespace_task_id_string_not_sequence(agents_service):
    norm = _norm(agents_service)
    # a bare string namespace is treated as [namespace]
    assert norm._namespace_task_id("tools:str") == "str"


def test_namespace_path_tuple(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_path(("a", "b")) == ["a", "b"]


def test_namespace_path_none(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_path(None) is None


def test_namespace_path_empty(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_path(()) is None


def test_namespace_path_string(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_path("solo") == ["solo"]


def test_namespace_token_first(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_token(("tools:abc", "model:def")) == "tools:abc"


def test_namespace_token_none(agents_service):
    norm = _norm(agents_service)
    assert norm._namespace_token(None) is None


# ----------------------------------------------------------------------------
# namespace binding (_bind_namespace_to_next_task / _resolve_namespace_label)
# ----------------------------------------------------------------------------
def test_resolve_namespace_label_none(agents_service):
    norm = _norm(agents_service)
    assert norm._resolve_namespace_label(None) is None


def test_bind_namespace_none(agents_service):
    norm = _norm(agents_service)
    assert norm._bind_namespace_to_next_task(None) is None


def test_bind_namespace_cached(agents_service):
    norm = _norm(agents_service)
    norm._namespace_task_labels[("ns",)] = "task-99"
    # already bound => returns the cached id, does not consume a pending task
    norm._pending_tasks["task-7"] = {"description": "d", "subagent_type": "r"}
    assert norm._bind_namespace_to_next_task(("ns",)) == "task-99"
    assert "task-7" in norm._pending_tasks


def test_bind_namespace_no_pending_task(agents_service):
    norm = _norm(agents_service)
    assert norm._bind_namespace_to_next_task(("ns",)) is None
    assert ("ns",) not in norm._namespace_task_labels


def test_bind_namespace_consumes_oldest_pending_task_fifo(agents_service):
    norm = _norm(agents_service)
    # Two task calls in order => FIFO binds the first namespace to the first.
    for tid, desc in (("task-1", "first"), ("task-2", "second")):
        ai = AIMessage(
            content="",
            tool_calls=[{"id": tid, "name": "task", "args": {"subagent_type": "r", "description": desc}}],
        )
        norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    assert list(norm._pending_tasks) == ["task-1", "task-2"]

    assert norm._bind_namespace_to_next_task(("tools:ns-a",)) == "task-1"
    assert norm._bind_namespace_to_next_task(("tools:ns-b",)) == "task-2"
    assert norm._namespace_task_labels == {("tools:ns-a",): "task-1", ("tools:ns-b",): "task-2"}
    assert norm._pending_tasks == {}


def test_bind_namespace_idempotent_no_double_consume(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "task-1", "name": "task", "args": {"subagent_type": "r", "description": "d"}}],
    )
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    norm._pending_tasks["task-2"] = {"description": "d2", "subagent_type": "r"}

    assert norm._bind_namespace_to_next_task(("tools:ns",)) == "task-1"
    # second call for the same namespace is a no-op; task-2 untouched
    assert norm._bind_namespace_to_next_task(("tools:ns",)) == "task-1"
    assert "task-2" in norm._pending_tasks


def test_resolve_namespace_label_prefers_bound_label(agents_service):
    norm = _norm(agents_service)
    norm._namespace_task_labels[("tools:raw",)] = "bound-task"
    # even though namespace-derived would be "raw", explicit binding wins
    assert norm._resolve_namespace_label(("tools:raw",)) == "bound-task"


def test_resolve_namespace_label_lazy_binds_to_pending_task(agents_service):
    norm = _norm(agents_service)
    ai = AIMessage(
        content="",
        tool_calls=[{"id": "task-1", "name": "task", "args": {"subagent_type": "r", "description": "d"}}],
    )
    norm.handle_chunk(("updates", {"agent": {"messages": [ai]}}))
    # First resolve of an unseen subagent namespace lazily binds to the pending
    # task even without a before_agent marker (reorder/absent-marker fallback).
    assert norm._resolve_namespace_label(("tools:raw",)) == "task-1"
    assert "task-1" not in norm._pending_tasks


def test_resolve_namespace_label_falls_back_to_derived(agents_service):
    norm = _norm(agents_service)
    # No pending task => fall back to the namespace-derived id.
    assert norm._resolve_namespace_label(("tools:raw",)) == "raw"


# ----------------------------------------------------------------------------
# namespace binding persistence across resume (thread-keyed)
# ----------------------------------------------------------------------------
def test_namespace_binding_rehydrated_across_instances(agents_service):
    mod = agents_service.normalizer
    tid = "thread-rehydrate-1"
    # First stream binds a namespace to its task tool_call_id.
    n1 = mod.AGUIStreamNormalizer(thread_id=tid)
    n1._pending_tasks["call_W"] = {"description": "d", "subagent_type": "writer"}
    assert n1._resolve_namespace_label(("tools:abc",)) == "call_W"

    # A fresh normalizer for the SAME thread (simulating /resume after a
    # subagent's own gated tool) rehydrates the binding even with no pending
    # task — so the subagent's continuation keeps its original task_id instead
    # of orphaning onto the raw namespace id.
    n2 = mod.AGUIStreamNormalizer(thread_id=tid)
    assert n2._pending_tasks == {}
    assert n2._resolve_namespace_label(("tools:abc",)) == "call_W"


def test_release_namespace_bindings_clears_store(agents_service):
    mod = agents_service.normalizer
    tid = "thread-release-1"
    n1 = mod.AGUIStreamNormalizer(thread_id=tid)
    n1._pending_tasks["call_X"] = {"description": "d", "subagent_type": "r"}
    n1._resolve_namespace_label(("tools:zzz",))

    mod.release_namespace_bindings(tid)

    # Store cleared => a fresh instance does NOT inherit; with no pending task it
    # falls back to the namespace-derived id.
    n2 = mod.AGUIStreamNormalizer(thread_id=tid)
    assert n2._resolve_namespace_label(("tools:zzz",)) == "zzz"


def test_namespace_bindings_isolated_per_thread(agents_service):
    mod = agents_service.normalizer
    a = mod.AGUIStreamNormalizer(thread_id="thread-A")
    a._pending_tasks["call_A"] = {"description": "d", "subagent_type": "r"}
    a._resolve_namespace_label(("tools:shared",))

    # A different thread must not inherit thread-A's binding for the same
    # namespace string; it binds its own pending task.
    b = mod.AGUIStreamNormalizer(thread_id="thread-B")
    b._pending_tasks["call_B"] = {"description": "d", "subagent_type": "r"}
    assert b._resolve_namespace_label(("tools:shared",)) == "call_B"

    mod.release_namespace_bindings("thread-A")
    mod.release_namespace_bindings("thread-B")


def test_empty_thread_id_does_not_persist(agents_service):
    mod = agents_service.normalizer
    n1 = mod.AGUIStreamNormalizer(thread_id="")
    n1._pending_tasks["call_E"] = {"description": "d", "subagent_type": "r"}
    n1._resolve_namespace_label(("tools:e",))

    # Threadless runs never resume, so nothing is persisted under "" (avoids
    # cross-run leakage); a fresh threadless instance falls back to derived id.
    n2 = mod.AGUIStreamNormalizer(thread_id="")
    assert n2._resolve_namespace_label(("tools:e",)) == "e"


# ----------------------------------------------------------------------------
# pure helpers — _fingerprint determinism
# ----------------------------------------------------------------------------
def test_fingerprint_deterministic(agents_service):
    norm = _norm(agents_service)
    a = norm._fingerprint({"b": 1, "a": 2})
    b = norm._fingerprint({"a": 2, "b": 1})
    assert a == b


def test_fingerprint_differs(agents_service):
    norm = _norm(agents_service)
    assert norm._fingerprint([1, 2]) != norm._fingerprint([2, 1])


# ----------------------------------------------------------------------------
# pure helpers — SSE -> payload parsing
# ----------------------------------------------------------------------------
def test_sse_to_payload_bytes(agents_service):
    norm = _norm(agents_service)
    frame = b'data: {"type": "X", "v": 1}\n\n'
    assert norm._sse_to_payload(frame) == {"type": "X", "v": 1}


def test_sse_to_payload_str(agents_service):
    norm = _norm(agents_service)
    frame = 'data: {"type": "Y"}\n\n'
    assert norm._sse_to_payload(frame) == {"type": "Y"}


def test_sse_to_payload_non_bytes_non_str(agents_service):
    norm = _norm(agents_service)
    assert norm._sse_to_payload(12345) is None


def test_sse_to_payload_bad_json(agents_service):
    norm = _norm(agents_service)
    frame = b"data: {not valid json}\n\n"
    assert norm._sse_to_payload(frame) is None


def test_sse_to_payload_non_dict_json(agents_service):
    norm = _norm(agents_service)
    frame = b"data: [1, 2, 3]\n\n"
    assert norm._sse_to_payload(frame) is None


def test_sse_to_payload_no_data_line(agents_service):
    norm = _norm(agents_service)
    assert norm._sse_to_payload(b"event: foo\n\n") is None


def test_sse_to_payload_invalid_utf8(agents_service):
    norm = _norm(agents_service)
    assert norm._sse_to_payload(b"\xff\xfe\x00") is None


# ----------------------------------------------------------------------------
# pure helpers — _raw_event_payload
# ----------------------------------------------------------------------------
def test_raw_event_payload_bytes(agents_service):
    norm = _norm(agents_service)
    p = norm._raw_event_payload(b"hello")
    assert p == {"type": "RAW_SSE_EVENT", "raw_sse": "hello"}


def test_raw_event_payload_str(agents_service):
    norm = _norm(agents_service)
    p = norm._raw_event_payload("hi")
    assert p == {"type": "RAW_SSE_EVENT", "raw_sse": "hi"}


def test_raw_event_payload_other(agents_service):
    norm = _norm(agents_service)
    p = norm._raw_event_payload(42)
    assert p["type"] == "RAW_SSE_EVENT"
    assert p["raw_sse"] == "42"


def test_raw_event_payload_invalid_utf8(agents_service):
    norm = _norm(agents_service)
    p = norm._raw_event_payload(b"\xff\xfe")
    assert p["type"] == "RAW_SSE_EVENT"


def test_wrap_subagent_uses_raw_fallback_on_undecodable(agents_service):
    norm = _norm(agents_service)
    # a frame that is not decodable as JSON SSE => raw fallback
    raw_frame = b"event: ping\n\n"
    wrapped = norm._wrap_subagent_events_if_needed([raw_frame], ("tools:task-1",))
    name, value = _custom_value(wrapped[0])
    assert value["event"]["type"] == "RAW_SSE_EVENT"


# ----------------------------------------------------------------------------
# pure helpers — _msg_kind
# ----------------------------------------------------------------------------
def test_msg_kind_tool_via_tool_call_id(agents_service):
    norm = _norm(agents_service)
    assert norm._msg_kind(ToolMessage(content="x", tool_call_id="t")) == "tool"


def test_msg_kind_ai(agents_service):
    norm = _norm(agents_service)
    assert norm._msg_kind(AIMessage(content="x")) == "ai"
    assert norm._msg_kind(AIMessageChunk(content="x")) == "ai"


def test_msg_kind_other(agents_service):
    norm = _norm(agents_service)
    assert norm._msg_kind(HumanMessage(content="x")) == "other"


def test_msg_kind_role_assistant(agents_service):
    norm = _norm(agents_service)

    class _M:
        role = "assistant"
        tool_call_id = None
        type = None

    assert norm._msg_kind(_M()) == "ai"


def test_msg_kind_role_tool(agents_service):
    norm = _norm(agents_service)

    class _M:
        role = "tool"
        tool_call_id = None
        type = "tool"

    assert norm._msg_kind(_M()) == "tool"


# ----------------------------------------------------------------------------
# state helpers
# ----------------------------------------------------------------------------
def test_actor_key_orchestrator_default(agents_service):
    norm = _norm(agents_service)
    assert norm._actor_key(None) == "__orchestrator__"
    assert norm._actor_key("") == "__orchestrator__"
    assert norm._actor_key("sub") == "sub"


def test_get_state_creates_and_caches(agents_service):
    norm = _norm(agents_service)
    s1 = norm._get_state("a")
    s1["response_started"] = True
    s2 = norm._get_state("a")
    assert s2["response_started"] is True


def test_push_skips_none(agents_service):
    norm = _norm(agents_service)
    out: list = []
    norm._push(out, None)
    assert out == []
    norm._push(out, b"x")
    assert out == [b"x"]


# ----------------------------------------------------------------------------
# thinking_end transition
# ----------------------------------------------------------------------------
def test_end_thinking_emits_when_started(agents_service):
    norm = _norm(agents_service)
    state = norm._get_state(None)
    state["thinking_started"] = True
    out: list = []
    norm._end_thinking_if_needed(out, None)
    assert _types(out) == ["THINKING_END"]
    assert state["thinking_started"] is False


def test_end_thinking_noop_when_not_started(agents_service):
    norm = _norm(agents_service)
    out: list = []
    norm._end_thinking_if_needed(out, None)
    assert out == []
