"""The normalizer's AG-UI stream: well-ordered lifecycles, the plan, compaction,
the orchestrator's own cards (artifact, chart, tool usage) and every provider's
message shapes."""

from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from harness.agui import normalizer as normalizer_module
from harness.agui.normalizer import AGUIStreamNormalizer, message_text, reasoning_parts
from harness.middlewares.summarization import COMPACTION_KEY
from harness.middlewares.tool_metrics import TOOL_METRICS_KEY

USAGE = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}


@pytest.fixture(autouse=True)
def _fresh_runs():
    normalizer_module._RUNS.clear()
    yield
    normalizer_module._RUNS.clear()


def _run(*chunks) -> list[dict]:
    norm = AGUIStreamNormalizer(thread_id="run-1")
    events = []
    for chunk in chunks:
        for frame in norm.handle_chunk(chunk):
            events += [json.loads(line[5:]) for line in frame.decode().splitlines() if line.startswith("data:")]
    return events


def _msg(message, ns=()):
    return (ns, "messages", (message, {}))


def _upd(node, message, ns=()):
    return (ns, "updates", {node: {"messages": [message]}})


def _flat(events):
    """(actor, event), sub-agent envelopes unwrapped."""
    for event in events:
        if event["type"] == "CUSTOM" and event["name"] == "SUBAGENT_EVENT":
            yield event["value"]["task_id"], event["value"]["event"]
        else:
            yield None, event


def _types(events, actor=None):
    return [e["type"] if e["type"] != "CUSTOM" else e["name"] for a, e in _flat(events) if a == actor]


def _assert_well_ordered(events):
    """Per actor: a text message is START, content, END; thoughts sit inside THINKING_START/END."""
    open_text, thinking, thought_open = {}, {}, {}
    for actor, event in _flat(events):
        kind = event["type"]
        if kind == "TEXT_MESSAGE_START":
            assert not open_text.get(actor), f"{actor}: second START while open"
            open_text[actor] = True
        elif kind == "TEXT_MESSAGE_CONTENT":
            assert open_text.get(actor), f"{actor}: content outside a message"
        elif kind == "TEXT_MESSAGE_END":
            assert open_text.get(actor), f"{actor}: END without START"
            open_text[actor] = False
        elif kind == "THINKING_START":
            thinking[actor] = True
        elif kind == "THINKING_END":
            assert not thought_open.get(actor)
            thinking[actor] = False
        elif kind == "THINKING_TEXT_MESSAGE_START":
            assert thinking.get(actor), f"{actor}: thought outside THINKING_START/END"
            thought_open[actor] = True
        elif kind == "THINKING_TEXT_MESSAGE_END":
            thought_open[actor] = False
    assert not any(open_text.values()), "a text message never ended"


# --- lifecycles ------------------------------------------------------------------

def test_each_model_call_is_one_text_message():
    events = _run(
        _msg(AIMessageChunk(content="Let me check.", id="m1")),
        _upd("model", AIMessage(content="Let me check.", id="m1", tool_calls=[{"id": "t1", "name": "search", "args": {}}])),
        _upd("tools", ToolMessage(content="found", tool_call_id="t1", name="search")),
        _msg(AIMessageChunk(content="Here it is.", id="m2")),
        _upd("model", AIMessage(content="Here it is.", id="m2")),
    )
    _assert_well_ordered(events)
    assert _types(events) == [
        "TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_END",
        "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_RESULT", "TOOL_CALL_END",
        "TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_END",
    ]


def test_thinking_spans_thoughts_and_tools_and_ends_before_the_reply():
    def summary(text, mid):
        return AIMessageChunk(content=[{"type": "reasoning", "index": 0, "summary": [
            {"index": 0, "type": "summary_text", "text": text}]}], id=mid)

    events = _run(
        _msg(summary("**Plan**\n\nSearch.", "m1")),
        _upd("model", AIMessage(content=[], id="m1", tool_calls=[{"id": "t1", "name": "search", "args": {}}])),
        _upd("tools", ToolMessage(content="ok", tool_call_id="t1", name="search")),
        _msg(summary("**Answer**\n\nShort.", "m2")),
        _msg(AIMessageChunk(content=[{"type": "text", "text": "Done.", "index": 1}], id="m2")),
        _upd("model", AIMessage(content=[{"type": "text", "text": "Done.", "index": 1}], id="m2")),
    )
    _assert_well_ordered(events)
    types = _types(events)
    assert types.count("THINKING_START") == 1 and types.count("THINKING_END") == 1
    assert types.index("THINKING_START") < types.index("TOOL_CALL_START") < types.index("THINKING_END")
    assert types.index("THINKING_END") < types.index("TEXT_MESSAGE_START")


def test_a_sub_agent_has_its_own_well_ordered_message():
    ns = ("tools:node-a",)
    events = _run(
        _upd("model", AIMessage(content="", id="m1", tool_calls=[
            {"id": "call-a", "name": "task", "args": {"subagent_type": "research", "description": "Find it"}}])),
        ((), "tasks", {"id": "node-a", "name": "tools", "input": [
            {"id": "call-a", "name": "task", "args": {"description": "Find it"}}]}),
        _msg(AIMessageChunk(content="Sub says hi", id="s1"), ns),
        _upd("model", AIMessage(content="Sub says hi", id="s1"), ns),
        _upd("tools", ToolMessage(content="Sub says hi", tool_call_id="call-a", name="task")),
        _msg(AIMessageChunk(content="Final.", id="m2")),
        _upd("model", AIMessage(content="Final.", id="m2")),
    )
    _assert_well_ordered(events)
    assert _types(events, "call-a") == [
        "BEFORE_AGENT_EVENT", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_END",
    ]
    assert _types(events) == [
        "TASK_SUBAGENT", "SUBAGENT_COMPLETED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_END",
    ]


# --- plan and compaction -------------------------------------------------------

def test_the_plan_is_sent_once_per_change():
    todos = [{"content": "Look", "status": "in_progress"}]
    events = _run(
        _upd("model", AIMessage(content="", id="m1", tool_calls=[{"id": "w1", "name": "write_todos", "args": {"todos": todos}}])),
        ((), "updates", {"tools": {"todos": todos, "messages": [
            ToolMessage(content="Updated", tool_call_id="w1", name="write_todos")]}}),
        _upd("model", AIMessage(content="", id="m2", tool_calls=[
            {"id": "w2", "name": "write_todos", "args": {"todos": [{"content": "Look", "status": "completed"}]}}])),
    )
    plans = [e["value"]["items"] for e in events if e.get("name") == "PLAN_SNAPSHOT"]
    assert [[i["status"] for i in plan] for plan in plans] == [["in_progress"], ["completed"]]
    assert "TOOL_CALL_START" not in _types(events)  # write_todos is never a tool card


def test_a_compaction_reports_start_cost_and_result():
    events = _run(
        ((), "messages", (AIMessageChunk(content="SESSION INTENT ...", id="s1", usage_metadata=USAGE),
                          {"lc_source": "summarization"})),
        _upd("model", AIMessage(content="Answer.", id="m1", usage_metadata=USAGE, response_metadata={
            COMPACTION_KEY: {"freed": 900, "summarized_messages": 12, "kept_messages": 4}})),
    )
    compactions = [e["value"] for e in events if e.get("name") == "CONTEXT_COMPACTION"]
    assert [c["phase"] for c in compactions] == ["started", "done"]
    assert compactions[1]["tokens_after"] == 10 and compactions[1]["tokens_before"] == 910
    usage = [e["value"] for e in events if e.get("name") == "TOKEN_USAGE"]
    assert [u.get("purpose") for u in usage] == ["compaction", None]
    assert "SESSION INTENT" not in json.dumps([e for e in events if e["type"].startswith("TEXT_MESSAGE")])


# --- the orchestrator's own cards ------------------------------------------------

def test_a_tool_card_ends_with_its_usage_and_a_malformed_stamp_is_dropped():
    stamp = {"tool_name": "search", "duration_ms": 12, "status": "ok", "output_chars": 5}
    events = _run(
        _upd("model", AIMessage(content="", id="m1", tool_calls=[
            {"id": "a", "name": "search", "args": {}}, {"id": "b", "name": "search", "args": {}}])),
        _upd("tools", ToolMessage(content="found", tool_call_id="a", name="search",
                                  response_metadata={TOOL_METRICS_KEY: stamp})),
        _upd("tools", ToolMessage(content="x", tool_call_id="b", name="search",
                                  response_metadata={TOOL_METRICS_KEY: {"duration_ms": None}})),
    )
    assert _types(events)[4:] == [
        "TOOL_CALL_RESULT", "TOOL_CALL_END", "TOOL_USAGE", "TOOL_CALL_RESULT", "TOOL_CALL_END",
    ]
    [usage] = [e["value"] for e in events if e.get("name") == "TOOL_USAGE"]
    assert usage == {**stamp, "tool_call_id": "a"}


def test_artifacts_and_charts_are_the_orchestrators_cards_only():
    chart = {"type": "bar", "title": "Sales", "x_key": "m", "series": [{"key": "v", "label": "Value"}],
             "data": [{"m": "Jan", "v": 3}]}
    ns = ("tools:node-a",)
    events = _run(
        _upd("model", AIMessage(content="", id="m1", tool_calls=[
            {"id": "pa", "name": "present_artifact", "args": {"path": "/out/report.md", "title": "Report"}},
            {"id": "ch", "name": "render_chart", "args": chart},
            {"id": "bad", "name": "render_chart", "args": {"title": ""}},
            {"id": "call-a", "name": "task", "args": {"subagent_type": "r", "description": "d"}}])),
        _upd("model", AIMessage(content="", id="s1", tool_calls=[
            {"id": "pa2", "name": "present_artifact", "args": {"path": "/a.csv", "title": "A"}},
            {"id": "ch2", "name": "render_chart", "args": chart}]), ns),
        _upd("tools", ToolMessage(content="ok", tool_call_id="pa", name="present_artifact")),
        _upd("tools", ToolMessage(content="ok", tool_call_id="ch", name="render_chart")),
    )
    assert _types(events) == ["PRESENT_ARTIFACT", "RENDER_CHART", "TASK_SUBAGENT"]
    assert _types(events, "call-a") == []  # a sub-agent's file or chart is scratch
    artifact = next(e["value"] for e in events if e.get("name") == "PRESENT_ARTIFACT")
    assert artifact["filename"] == "report.md" and artifact["mime"] == "text/markdown"


# --- provider shapes ------------------------------------------------------------

@pytest.mark.parametrize("msg, expected", [
    # OpenAI Responses (as langchain-openai marks it): one part per summary part.
    (AIMessage(content=[{"type": "reasoning", "summary": [
        {"index": 0, "type": "summary_text", "text": "A"}, {"index": 1, "type": "summary_text", "text": "B"}]}],
        response_metadata={"model_provider": "openai"}), ["A", "B"]),
    # Anthropic extended thinking.
    (AIMessage(content=[{"type": "thinking", "thinking": "Hmm.", "signature": "s"}, {"type": "text", "text": "Hi"}],
               response_metadata={"model_provider": "anthropic"}), ["Hmm."]),
    # DeepSeek / xAI / Groq / Ollama: reasoning_content in additional_kwargs.
    (AIMessage(content="Hi", additional_kwargs={"reasoning_content": "Think."},
               response_metadata={"model_provider": "deepseek"}), ["Think."]),
    (AIMessageChunk(content="", additional_kwargs={"reasoning_content": "Think."}), ["Think."]),
    # Bedrock Converse.
    (AIMessage(content=[{"type": "reasoning_content", "reasoning_content": {"text": "Weigh.", "signature": "s"}},
                        {"type": "text", "text": "Hi"}], response_metadata={"model_provider": "bedrock_converse"}),
     ["Weigh."]),
    # No reasoning at all.
    (AIMessage(content="plain"), []),
])
def test_reasoning_from_every_provider(msg, expected):
    assert [text for _key, text in reasoning_parts(msg)] == expected


def test_reply_text_never_includes_reasoning_or_tool_input_and_keeps_bare_strings():
    gemini = AIMessage(content=[{"type": "thinking", "thinking": "x"}, "Hello"],
                       response_metadata={"model_provider": "google_genai"})
    anthropic = AIMessage(content=[
        {"type": "thinking", "thinking": "x", "signature": "s"},
        {"type": "text", "text": "Checking."},
        {"type": "tool_use", "id": "t", "name": "search", "input": {"q": "x"}},
    ], response_metadata={"model_provider": "anthropic"})
    assert message_text(gemini) == "Hello"
    assert message_text(anthropic) == "Checking."
    assert message_text(AIMessageChunk(content="token")) == "token"


def test_xai_style_reasoning_reaches_the_chain_of_thought():
    events = _run(
        _msg(AIMessageChunk(content="", additional_kwargs={"reasoning_content": "Thinking hard."}, id="m1")),
        _msg(AIMessageChunk(content="Answer.", id="m1")),
        _upd("model", AIMessage(content="Answer.", additional_kwargs={"reasoning_content": "Thinking hard."}, id="m1")),
    )
    _assert_well_ordered(events)
    assert [e["delta"] for e in events if e["type"] == "THINKING_TEXT_MESSAGE_CONTENT"] == ["Thinking hard."]
