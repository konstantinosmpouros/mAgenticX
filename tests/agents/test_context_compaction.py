"""Compaction you can trigger and see (plan 34).

Pinned:

* an edit/retry fork of a compacted branch keeps the compaction (it used to
  start again from the full raw history: private channels do not survive a
  write through the input);
* all of it on a real deep-agent graph too, whose ``messages`` is a delta
  channel — a raw checkpoint there holds only the latest delta, which once made
  every manual compaction see an empty conversation;
* a manual compaction summarizes all but the manual share, offloads the
  history under the thread's name, books the summary call's usage, and the next
  turn's model sees ``summary + recent``;
* it cuts at a turn boundary — the latest exchange (question, tool calls,
  answer) is kept whole — only once the context is past 5% of the window (the
  ring's own reading), and it counts only what the person sees;
* a stand-in text from LangChain ("too long to summarize"…) is never saved as
  a summary, and the summary call reads everything it folds, not 4000 tokens;
* nothing old enough → nothing written; a moved head → a conflict; a failed
  summary → nothing written;
* undo restores the state from before, only while the compaction is the head;
* an automatic compaction is stamped on the reply it ran in front of, and the
  normalizer turns it into ``CONTEXT_COMPACTION`` started/done plus a
  ``TOKEN_USAGE`` with ``purpose: compaction`` — never the summary's text.
"""
from __future__ import annotations

import json

import pytest
from deepagents import create_deep_agent
from deepagents._models import get_model_provider, resolve_model
from deepagents.backends import FilesystemBackend
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from core.settings import settings
from harness.abstractions import DeepAgent
from harness.agui.normalizer import AGUIStreamNormalizer
from harness.checkpointer import CompactionConflict, CompactionFailed, compact_thread, undo_compaction
from harness.checkpointer.fork import seed_thread_from_checkpoint
from harness.middlewares.usage_metrics import context_window
from harness.middlewares import (
    COMPACTION_KEY,
    EVENT_KEY,
    ConfigurableSummarizationMiddleware,
    exclude_stock_summarization,
    summary_cutoff,
    visible_messages,
)

USAGE = {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150}


def _replies():
    turn = 0
    while True:
        turn += 1
        yield AIMessage(content=f"reply {turn} " + "word " * 40, usage_metadata=USAGE)


class _Seen:
    """Records what the agent's model was shown on each call."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []


class _ToolTolerantFake(GenericFakeChatModel):
    """A fake chat model a deep agent can bind its built-in tools to."""

    def bind_tools(self, tools, **kwargs):
        return self


def _graph(tmp_path, *, summary_model, seen: _Seen, trigger=("tokens", 10**9), keep=("messages", 2), kind="plain"):
    """A plain LangChain agent, or (``kind="deep"``) a real deep agent — the
    graph production runs, with its delta ``messages`` channel."""

    class Spy(AgentMiddleware):
        async def awrap_model_call(self, request, handler):
            seen.calls.append([str(m.content)[:12] for m in request.messages])
            return await handler(request)

    summarizer = ConfigurableSummarizationMiddleware(
        summary_model,
        backend=FilesystemBackend(root_dir=str(tmp_path), virtual_mode=True),
        trigger=trigger,
        keep=keep,
    )
    if kind == "deep":
        model = _ToolTolerantFake(messages=_replies())
        # As build_deep_agent does: drop deepagents' stock summarizer, or it
        # applies the same compaction a second time. The fake has no model
        # spec, so its profile resolves through its provider key.
        exclude_stock_summarization(get_model_provider(model))
        graph = create_deep_agent(
            model=model,
            middleware=[summarizer, Spy()],
            checkpointer=InMemorySaver(),
        )
    else:
        graph = create_agent(
            model=GenericFakeChatModel(messages=_replies()),
            middleware=[summarizer, Spy()],
            checkpointer=InMemorySaver(),
        )
    return graph, summarizer


def _summary_model(text="THE SUMMARY"):
    return GenericFakeChatModel(
        messages=iter([AIMessage(content=text, usage_metadata={"input_tokens": 900, "output_tokens": 40, "total_tokens": 940})] * 4)
    )


async def _turns(graph, thread_id, count):
    cfg = {"configurable": {"thread_id": thread_id}}
    for i in range(count):
        await graph.ainvoke({"messages": [HumanMessage(content=f"question {i}")]}, cfg)
    head = await graph.checkpointer.aget_tuple(cfg)
    return cfg, head.config["configurable"]["checkpoint_id"]


@pytest.mark.parametrize("kind", ["plain", "deep"])
async def test_manual_compaction_summarizes_and_the_next_turn_sees_it(tmp_path, kind):
    seen = _Seen()
    graph, summarizer = _graph(tmp_path, summary_model=_summary_model(), seen=seen, kind=kind)
    cfg, head = await _turns(graph, "t-1", 3)

    result = await compact_thread(graph=graph, summarizer=summarizer, thread_id="t-1", expected_checkpoint_id=head)

    assert result.compacted and result.checkpoint_id != head
    assert (result.summarized_messages, result.kept_messages) == (4, 2)
    assert result.summary == "THE SUMMARY"
    assert result.tokens_before == USAGE["total_tokens"]
    assert 0 < result.freed <= result.tokens_before
    assert result.tokens_after == result.tokens_before - result.freed
    assert (result.usage["calls"], result.usage["input_tokens"], result.usage["output_tokens"]) == (1, 900, 40)
    # The full history went to disk under the thread's name, like an auto compaction.
    assert (tmp_path / "conversation_history" / "t-1.md").exists()

    saved = await graph.checkpointer.aget_tuple(cfg)
    assert saved.checkpoint["channel_values"][EVENT_KEY]["cutoff_index"] == 4

    seen.calls.clear()
    await graph.ainvoke({"messages": [HumanMessage(content="question 3")]}, cfg)
    shown = seen.calls[0]
    assert "THE SUMMARY" in shown[0] or shown[0].startswith("You are in")
    assert shown[1:] == ["question 2", "reply 3 word", "question 3"]


async def test_nothing_old_enough_writes_nothing(tmp_path):
    # One exchange only: the latest exchange is always kept whole.
    graph, summarizer = _graph(tmp_path, summary_model=_summary_model(), seen=_Seen())
    cfg, head = await _turns(graph, "t-2", 1)

    result = await compact_thread(graph=graph, summarizer=summarizer, thread_id="t-2", expected_checkpoint_id=head)

    assert not result.compacted
    assert (await graph.checkpointer.aget_tuple(cfg)).config["configurable"]["checkpoint_id"] == head


@pytest.mark.parametrize(("window", "compacts"), [(100_000, False), (1_000, True)])
async def test_compacting_starts_past_five_percent_of_the_window(tmp_path, window, compacts):
    # The last reply's prompt is 120 tokens: 0.12% of a 100K window, 12% of 1K.
    summary_model = _summary_model()
    summary_model.profile = {"max_input_tokens": window}
    graph, summarizer = _graph(tmp_path, summary_model=summary_model, seen=_Seen())
    cfg, head = await _turns(graph, "t-floor", 3)

    result = await compact_thread(graph=graph, summarizer=summarizer, thread_id="t-floor", expected_checkpoint_id=head)

    assert result.compacted is compacts
    if compacts:
        assert result.kept_messages == 2  # the latest exchange, by default


async def test_a_moved_head_is_a_conflict(tmp_path):
    graph, summarizer = _graph(tmp_path, summary_model=_summary_model(), seen=_Seen())
    _cfg, head = await _turns(graph, "t-3", 3)

    with pytest.raises(CompactionConflict):
        await compact_thread(graph=graph, summarizer=summarizer, thread_id="t-3", expected_checkpoint_id="stale")
    with pytest.raises(CompactionConflict):
        await undo_compaction(graph=graph, thread_id="t-3", expected_checkpoint_id="stale")
    assert head


async def test_a_failed_summary_writes_nothing(tmp_path):
    class Broken(GenericFakeChatModel):
        async def _agenerate(self, *args, **kwargs):
            raise RuntimeError("provider down")

    graph, summarizer = _graph(tmp_path, summary_model=Broken(messages=iter([])), seen=_Seen())
    cfg, head = await _turns(graph, "t-4", 3)

    with pytest.raises(CompactionFailed):
        await compact_thread(graph=graph, summarizer=summarizer, thread_id="t-4", expected_checkpoint_id=head)
    assert (await graph.checkpointer.aget_tuple(cfg)).config["configurable"]["checkpoint_id"] == head


@pytest.mark.parametrize("kind", ["plain", "deep"])
async def test_undo_restores_the_state_from_before(tmp_path, kind):
    seen = _Seen()
    graph, summarizer = _graph(tmp_path, summary_model=_summary_model(), seen=seen, kind=kind)
    cfg, head = await _turns(graph, "t-5", 3)
    result = await compact_thread(graph=graph, summarizer=summarizer, thread_id="t-5", expected_checkpoint_id=head)

    restored = await undo_compaction(graph=graph, thread_id="t-5", expected_checkpoint_id=result.checkpoint_id)

    saved = await graph.checkpointer.aget_tuple(cfg)
    assert saved.config["configurable"]["checkpoint_id"] == restored
    assert saved.checkpoint["channel_values"].get(EVENT_KEY) is None
    seen.calls.clear()
    await graph.ainvoke({"messages": [HumanMessage(content="again")]}, cfg)
    assert seen.calls[0][0] == "question 0"
    # Once a turn ran on top, the compaction can no longer be taken back.
    with pytest.raises(CompactionConflict):
        await undo_compaction(graph=graph, thread_id="t-5", expected_checkpoint_id=restored)


@pytest.mark.parametrize("kind", ["plain", "deep"])
async def test_a_fork_keeps_the_compaction(tmp_path, kind):
    seen = _Seen()
    graph, summarizer = _graph(tmp_path, summary_model=_summary_model(), seen=seen, kind=kind)
    _cfg, head = await _turns(graph, "src", 3)
    result = await compact_thread(graph=graph, summarizer=summarizer, thread_id="src", expected_checkpoint_id=head)

    seeded = await seed_thread_from_checkpoint(
        graph=graph, source_thread_id="src", source_checkpoint_id=result.checkpoint_id, target_thread_id="branch"
    )

    assert seeded
    branch = {"configurable": {"thread_id": "branch"}}
    assert (await graph.checkpointer.aget_tuple(branch)).checkpoint["channel_values"].get(EVENT_KEY)
    seen.calls.clear()
    await graph.ainvoke({"messages": [HumanMessage(content="edited")]}, branch)
    assert seen.calls[0][1:] == ["question 2", "reply 3 word", "edited"]


async def test_an_automatic_compaction_is_stamped_on_the_reply(tmp_path):
    graph, _summarizer = _graph(
        tmp_path, summary_model=_summary_model(), seen=_Seen(), trigger=("messages", 5), keep=("messages", 2)
    )
    cfg, _head = await _turns(graph, "t-6", 3)

    state = await graph.aget_state(cfg)
    stamped = [m.response_metadata[COMPACTION_KEY] for m in state.values["messages"]
               if isinstance(m, AIMessage) and COMPACTION_KEY in (m.response_metadata or {})]
    assert len(stamped) == 1
    # q0 r1 q1 r2 q2 hit the 5-message trigger; the last two are kept.
    assert (stamped[0]["summarized_messages"], stamped[0]["kept_messages"]) == (4, 1)
    assert stamped[0]["freed"] >= 0


def _events(frames):
    out = []
    for frame in frames:
        for line in frame.decode("utf-8").splitlines():
            if line.startswith("data:"):
                payload = json.loads(line[5:].strip())
                out.append((payload.get("name") or payload.get("type"), payload.get("value")))
    return out


def test_the_normalizer_reports_an_automatic_compaction():
    norm = AGUIStreamNormalizer(thread_id="run-1")
    meta = {"lc_source": "summarization"}

    started = norm.handle_chunk(((), "messages", (AIMessageChunk(content="SESSION SUMMARY", id="sum-1"), meta)))
    usage = norm.handle_chunk(((), "messages", (AIMessageChunk(content="", id="sum-1", usage_metadata=USAGE), meta)))
    again = norm.handle_chunk(((), "messages", (AIMessage(content="SESSION SUMMARY", id="sum-1", usage_metadata=USAGE), meta)))
    reply = AIMessage(
        content="answer",
        id="ai-1",
        usage_metadata={"input_tokens": 40_000, "output_tokens": 10, "total_tokens": 40_010},
        response_metadata={COMPACTION_KEY: {"freed": 90_000, "summarized_messages": 30, "kept_messages": 4},
                           "mx_usage_metrics": {"context_window": 272_000}},
    )
    done = norm.handle_chunk(((), "updates", {"model": {"messages": [reply]}}))

    assert _events(started) == [("CONTEXT_COMPACTION", {"phase": "started", "trigger": "auto"})]
    [(name, value)] = _events(usage)
    assert name == "TOKEN_USAGE" and value["purpose"] == "compaction" and value["message_id"] == "sum-1"
    assert _events(again) == []  # same call, counted once; its text never surfaces
    names = [name for name, _ in _events(done)]
    assert names.index("CONTEXT_COMPACTION") < names.index("TOKEN_USAGE")
    value = dict(_events(done))["CONTEXT_COMPACTION"]
    assert value == {
        "phase": "done", "trigger": "auto", "tokens_after": 40_000, "freed": 90_000, "tokens_before": 130_000,
        "window": 272_000, "summarized_messages": 30, "kept_messages": 4,
    }


def test_the_cut_keeps_the_latest_exchange_whole_and_counts_what_is_seen():
    summary = HumanMessage(content="S", additional_kwargs={"lc_source": "summarization"})
    messages = [
        summary,
        AIMessage(content="", tool_calls=[{"id": "c1", "name": "search", "args": {}}]),
        ToolMessage(content="User rejected this action.", tool_call_id="c1"),
        AIMessage(content="answer to again"),
        HumanMessage(content="summarize it"),
        AIMessage(content="", tool_calls=[{"id": "c2", "name": "search", "args": {}}]),
        ToolMessage(content="[]", tool_call_id="c2"),
        AIMessage(content="the summary"),
    ]
    cut = summary_cutoff(messages)
    assert cut == 4  # "summarize it" and everything after it stay whole
    # Before the cut the person sees one bubble (the answer); never the earlier
    # summary, the tool call or its result.
    assert visible_messages(messages, 0, cut) == 1
    assert visible_messages(messages, cut, len(messages)) == 2

    # Only the previous summary before the newest question: nothing new to fold.
    assert summary_cutoff([summary, HumanMessage(content="q"), AIMessage(content="a")]) == 0


@pytest.mark.parametrize("stand_in", [
    "Previous conversation was too long to summarize.",
    "No previous conversation history.",
    "Error generating summary: boom",
])
async def test_a_stand_in_text_is_never_saved_as_a_summary(tmp_path, stand_in):
    graph, summarizer = _graph(tmp_path, summary_model=_summary_model(stand_in), seen=_Seen())
    cfg, head = await _turns(graph, "t-stand-in", 3)

    with pytest.raises(CompactionFailed):
        await compact_thread(graph=graph, summarizer=summarizer, thread_id="t-stand-in", expected_checkpoint_id=head)
    assert (await graph.checkpointer.aget_tuple(cfg)).config["configurable"]["checkpoint_id"] == head


def test_automatic_compaction_cuts_where_manual_does_and_reads_everything_it_folds(tmp_path):
    _, summarizer = _graph(tmp_path, summary_model=_summary_model(), seen=_Seen())
    messages = [HumanMessage(content="q1"), AIMessage(content="a1"), HumanMessage(content="q2")]
    assert summarizer._determine_cutoff_index(messages) == 2
    assert summarizer._lc_helper.trim_tokens_to_summarize is None


def test_a_model_newer_than_langchain_gets_its_declared_window():
    # gpt-6-luna has no profile in the pinned langchain-openai: without the
    # declared window, compaction and the context ring would have none.
    DeepAgent.register_model_windows()
    model = resolve_model("openai:gpt-6-luna")
    assert context_window(model) == settings.model_profiles.context_windows["openai:gpt-6-luna"]
