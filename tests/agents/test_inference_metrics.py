"""Inference metrics (plan 41): time to first token and per-tool-call metrics.

Pinned:

* a streamed model call carries ``ttft_ms`` — measured by the first-token
  callback, reported by ``UsageMetricsMiddleware`` — and a call that did not
  stream carries none;
* two model calls running at once each get their own first token;
* a LangGraph agent's run callback measures ``ttft_ms`` per callback run id;
* ``ToolMetricsMiddleware`` stamps duration, status and output size on a tool
  result — an error converted by ``ToolErrorMiddleware`` counts as an error,
  a ``Command`` result is stamped with no output, and ``GraphBubbleUp`` passes
  through untouched;
* the normalizer emits ``TOOL_USAGE`` right after the call's result (wrapped in
  ``SUBAGENT_EVENT`` for a sub-agent), and never for a tool it hides;
* a LangGraph agent reports its tool calls as ``TOOL_USAGE`` through its run
  callback;
* every deep agent and sub-agent gets ``ToolMetricsMiddleware`` exactly once,
  directly outside ``ToolErrorMiddleware``, and every deep-agent run carries
  the first-token callback.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from types import SimpleNamespace
from typing import Any, TypedDict
from uuid import uuid4

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, LLMResult
from langchain_core.tools import tool
from langgraph.errors import GraphInterrupt
from langgraph.graph import END, START
from langgraph.types import Command

from harness.abstractions import deep_agent as deep_agent_module
from harness.abstractions.deep_agent import DeepAgent
from harness.abstractions.langgraph_agent import LangGraphAgent
from harness.agui.emitter import AGUIEmitter
from harness.agui.normalizer import AGUIStreamNormalizer
from harness.agui.usage_callback import UsageMetricsCallback
from harness.middlewares import (
    FirstTokenCallback,
    RetryOnRateLimitMiddleware,
    ToolErrorMiddleware,
    ToolMetricsMiddleware,
    UsageMetricsMiddleware,
)
from harness.middlewares.first_token import first_token_scope, is_first_token
from harness.middlewares.tool_metrics import TOOL_METRICS_KEY, content_chars
from harness.middlewares.usage_metrics import METRICS_KEY

USAGE = {"input_tokens": 40, "output_tokens": 3, "total_tokens": 43}


class StreamingFake(GenericFakeChatModel):
    """A chat model that streams its reply word by word after ``delay`` seconds,
    then a usage-only chunk — the shape a provider stream has."""

    delay: float = 0.0

    def bind_tools(self, tools: Any, **kwargs: Any) -> StreamingFake:
        return self

    def _stream(self, messages, stop=None, run_manager=None, **kwargs) -> Iterator[ChatGenerationChunk]:
        yield from super()._stream(messages, stop=stop, run_manager=run_manager, **kwargs)
        last = ChatGenerationChunk(message=AIMessageChunk(content="", usage_metadata=USAGE))
        if run_manager:
            run_manager.on_llm_new_token("", chunk=last)
        yield last

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs) -> AsyncIterator[ChatGenerationChunk]:
        await asyncio.sleep(self.delay)
        # The caller reports each chunk's token itself.
        for chunk in self._stream(messages, stop=stop, **kwargs):
            yield chunk


def _frames(chunks: list[bytes]) -> list[dict]:
    """The JSON payloads of a list of SSE frames."""
    return [json.loads(c.decode().split("data:", 1)[1].strip()) for c in chunks]


def _names(frames: list[dict]) -> list[str]:
    return [f["name"] if f.get("type") == "CUSTOM" else f["type"] for f in frames]


# ------------------------------------------------------------ time to first token
async def _answer(model: StreamingFake, callback: Any, stream_mode: Any) -> dict:
    """Run a one-call agent and return the usage stamp on its reply."""
    agent = create_agent(model=model, tools=[], middleware=[UsageMetricsMiddleware()])
    replies: list[AIMessage] = []
    async for mode, chunk in agent.astream(
        {"messages": [HumanMessage(content="hi")]},
        config={"callbacks": [callback]},
        stream_mode=["updates"] if stream_mode == "updates" else ["messages", "updates"],
    ):
        if mode == "updates":
            for update in chunk.values():
                replies += [m for m in (update or {}).get("messages", []) if isinstance(m, AIMessage)]
    [reply] = replies
    return reply.response_metadata[METRICS_KEY]


def test_a_streamed_call_reports_its_time_to_first_token():
    model = StreamingFake(messages=iter(["hello there world"]), delay=0.08)
    metrics = asyncio.run(_answer(model, FirstTokenCallback(), "messages"))

    assert metrics["ttft_ms"] >= 60
    assert metrics["ttft_ms"] <= metrics["latency_ms"]


def test_a_call_that_did_not_stream_reports_no_time_to_first_token():
    # Without the `messages` stream mode nothing asks the model to stream.
    model = StreamingFake(messages=iter([AIMessage(content="hello", usage_metadata=USAGE)]))
    metrics = asyncio.run(_answer(model, FirstTokenCallback(), "updates"))

    assert "ttft_ms" not in metrics
    assert isinstance(metrics["latency_ms"], int)


def test_two_concurrent_calls_each_get_their_own_first_token():
    callback = FirstTokenCallback()  # one instance serves the whole run, like a deep agent's

    async def both():
        fast = StreamingFake(messages=iter(["quick answer"]), delay=0.02)
        slow = StreamingFake(messages=iter(["slow answer"]), delay=0.35)
        return await asyncio.gather(_answer(slow, callback, "messages"), _answer(fast, callback, "messages"))

    slow_metrics, fast_metrics = asyncio.run(both())
    assert slow_metrics["ttft_ms"] >= 300
    assert fast_metrics["ttft_ms"] < 300


def test_the_first_token_ignores_empty_chunks_and_counts_tool_call_fragments():
    empty = ChatGenerationChunk(message=AIMessageChunk(content=""))
    tool_call = ChatGenerationChunk(message=AIMessageChunk(
        content="", tool_call_chunks=[{"name": "search", "args": "", "id": "c1", "index": 0}]
    ))
    assert not is_first_token("", empty)
    assert is_first_token("", tool_call)
    assert is_first_token("Hi", None)


def test_the_callback_stamps_only_the_run_its_call_started():
    callback, mine, other = FirstTokenCallback(), uuid4(), uuid4()
    with first_token_scope() as record:
        callback.on_chat_model_start({}, [[]], run_id=mine)
        callback.on_llm_new_token("stray", run_id=other)
        assert record.first_token_at is None
        callback.on_llm_new_token("mine", run_id=mine)
        first = record.first_token_at
        callback.on_llm_new_token("again", run_id=mine)
    assert first is not None and record.first_token_at == first
    # Outside any call there is nothing to stamp, and nothing fails.
    callback.on_llm_new_token("late", run_id=mine)


def test_ttft_rides_the_token_usage_event():
    event = AGUIEmitter().token_usage(USAGE, message_id="m1", metrics={"model": "gpt-5", "latency_ms": 900, "ttft_ms": 250})
    [payload] = _frames([event])
    assert payload["value"]["ttft_ms"] == 250
    [without] = _frames([AGUIEmitter().token_usage(USAGE, message_id="m2", metrics={"latency_ms": 9})])
    assert "ttft_ms" not in without["value"]


def test_the_langgraph_callback_measures_ttft_per_run():
    callback = UsageMetricsCallback()
    streamed, unstreamed = uuid4(), uuid4()
    empty = ChatGenerationChunk(message=AIMessageChunk(content=""))

    async def scenario():
        await callback.on_chat_model_start({}, [[]], run_id=streamed, metadata={"ls_model_name": "gpt-4o"})
        await callback.on_chat_model_start({}, [[]], run_id=unstreamed, metadata={"ls_model_name": "gpt-4o"})
        callback.on_llm_new_token("", chunk=empty, run_id=streamed)       # role-only opener: not a token
        await asyncio.sleep(0.03)
        callback.on_llm_new_token("Hi", run_id=streamed)
        message = AIMessage(content="Hi", usage_metadata=USAGE)
        for run_id in (streamed, unstreamed):
            await callback.on_llm_end(LLMResult(generations=[[ChatGeneration(message=message)]]), run_id=run_id)

    asyncio.run(scenario())
    first, second = callback.drain()
    assert first[1] == f"lg-{streamed}" and 20 <= first[2]["ttft_ms"] <= first[2]["latency_ms"]
    assert "ttft_ms" not in second[2]


class _State(TypedDict, total=False):
    done: bool


class _OneNodeAgent(LangGraphAgent):
    """A LangGraph agent whose single node runs ``work(self, config)``."""

    name = "inference-metrics-test"

    def __init__(self, work):
        super().__init__(config={"run_config": {"configurable": {"thread_id": "inference-metrics"}}})
        self.state = _State
        self._work = work

    def _durable_checkpointer(self):
        return None

    def register_agents(self):
        return object()

    def register_nodes(self):
        async def node(state, config):
            await self._work(config)
            return {"done": True}
        return node

    def register_graph_nodes(self, graph):
        graph.add_node("work", self.nodes)
        return graph

    def register_graph_edges(self, graph):
        graph.add_edge(START, "work")
        graph.add_edge("work", END)
        return graph


def _run(agent: LangGraphAgent) -> list[dict]:
    async def run() -> list[bytes]:
        return [chunk async for chunk in agent.astream({})]
    return _frames(asyncio.run(run()))


def test_a_langgraph_agent_reports_ttft_for_the_calls_it_streams():
    model = StreamingFake(messages=iter(["streamed answer", AIMessage(content="whole", usage_metadata=USAGE)]), delay=0.03)

    async def work(config):
        async for _ in model.astream("q", config):
            pass
        await model.ainvoke("q", config)

    usage = [f["value"] for f in _run(_OneNodeAgent(work)) if f.get("name") == "TOKEN_USAGE"]
    assert len(usage) == 2
    assert usage[0]["ttft_ms"] >= 20
    assert "ttft_ms" not in usage[1]


# ------------------------------------------------------------------ tool metrics
def _request(name: str = "search", call_id: str = "c1") -> SimpleNamespace:
    return SimpleNamespace(tool_call={"id": call_id, "name": name, "args": {}})


def _compose(stack: list[Any]):
    """The tool-call chain an agent builds from ``stack`` (first = outermost)."""
    wrappers = [m for m in stack if isinstance(m, (ToolErrorMiddleware, ToolMetricsMiddleware))]

    def chain(index: int, handler):
        if index == len(wrappers):
            return handler
        inner = chain(index + 1, handler)
        return lambda request: wrappers[index].awrap_tool_call(request, inner)

    return chain


def test_a_tool_result_is_stamped_with_its_metrics():
    async def handler(request):
        await asyncio.sleep(0.02)
        return ToolMessage(content="twelve chars", tool_call_id="c1", name="search")

    result = asyncio.run(ToolMetricsMiddleware().awrap_tool_call(_request(), handler))
    stamp = result.response_metadata[TOOL_METRICS_KEY]
    assert stamp["tool_name"] == "search" and stamp["status"] == "ok"
    assert stamp["output_chars"] == 12 and stamp["duration_ms"] >= 15


def test_a_tool_that_raised_is_counted_as_an_error():
    stack = DeepAgent._ensure_platform_middleware(None)

    async def failing(request):
        raise RuntimeError("HTTP 400")

    result = asyncio.run(_compose(stack)(0, failing)(_request("fetch")))
    assert result.status == "error"
    stamp = result.response_metadata[TOOL_METRICS_KEY]
    assert stamp["status"] == "error" and stamp["tool_name"] == "fetch"
    assert stamp["output_chars"] == len(result.content)


def test_a_command_result_is_stamped_without_output_and_left_whole():
    message = ToolMessage(content="sub-agent answer", tool_call_id="c1")

    async def handler(request):
        return Command(update={"messages": [message], "files": {}})

    result = asyncio.run(ToolMetricsMiddleware().awrap_tool_call(_request("task"), handler))
    assert isinstance(result, Command) and result.update["messages"] == [message]
    assert message.response_metadata[TOOL_METRICS_KEY]["output_chars"] == 0

    async def bare(request):
        return Command(update={"files": {}})

    assert asyncio.run(ToolMetricsMiddleware().awrap_tool_call(_request(), bare)).update == {"files": {}}


def test_an_interrupt_passes_through_the_stack_untouched():
    stack = DeepAgent._ensure_platform_middleware(None)

    async def pausing(request):
        raise GraphInterrupt(())

    with pytest.raises(GraphInterrupt):
        asyncio.run(_compose(stack)(0, pausing)(_request()))


def test_the_sync_path_stamps_too():
    result = ToolMetricsMiddleware().wrap_tool_call(
        _request(), lambda request: ToolMessage(content=[{"type": "text", "text": "abc"}, {"type": "image"}], tool_call_id="c1")
    )
    assert result.response_metadata[TOOL_METRICS_KEY]["output_chars"] == 3
    assert content_chars(None) == 0


# -------------------------------------------------------------------- normalizer
def _tool_call_turn(call_id: str, name: str) -> dict:
    return {"model": {"messages": [AIMessage(content="", tool_calls=[{"id": call_id, "name": name, "args": {}}])]}}


def _tool_result(call_id: str, name: str, status: str = "success") -> dict:
    message = ToolMessage(content="result", tool_call_id=call_id, name=name, status=status)
    message.response_metadata = {TOOL_METRICS_KEY: {
        "tool_name": name, "duration_ms": 120, "status": "error" if status == "error" else "ok", "output_chars": 6,
    }}
    return {"tools": {"messages": [message]}}


def test_the_normalizer_emits_tool_usage_after_the_result():
    normalizer = AGUIStreamNormalizer(thread_id=f"tm-{uuid4()}")
    frames = _frames(normalizer.handle_chunk(_tool_call_turn("c1", "search")))
    frames += _frames(normalizer.handle_chunk(_tool_result("c1", "search", status="error")))

    names = _names(frames)
    assert names.index("TOOL_USAGE") > names.index("TOOL_CALL_RESULT")
    [usage] = [f["value"] for f in frames if f.get("name") == "TOOL_USAGE"]
    assert usage == {"tool_call_id": "c1", "tool_name": "search", "duration_ms": 120,
                     "status": "error", "output_chars": 6}
    # The same result arriving again (messages + updates) is not counted twice.
    assert normalizer.handle_chunk(("messages", _tool_result("c1", "search")["tools"]["messages"][0])) == []


def test_no_tool_usage_for_a_tool_the_normalizer_hides():
    normalizer = AGUIStreamNormalizer(thread_id=f"tm-{uuid4()}")
    normalizer.handle_chunk(_tool_call_turn("t1", "write_todos"))
    assert "TOOL_USAGE" not in _names(_frames(normalizer.handle_chunk(_tool_result("t1", "write_todos"))))


def test_no_tool_usage_without_a_stamp():
    normalizer = AGUIStreamNormalizer(thread_id=f"tm-{uuid4()}")
    normalizer.handle_chunk(_tool_call_turn("c2", "search"))
    bare = {"tools": {"messages": [ToolMessage(content="result", tool_call_id="c2", name="search")]}}
    assert "TOOL_USAGE" not in _names(_frames(normalizer.handle_chunk(bare)))


def test_a_sub_agents_tool_usage_is_wrapped_like_its_other_events():
    normalizer = AGUIStreamNormalizer(thread_id=f"tm-{uuid4()}")
    namespace = ("tools:sub-1",)
    normalizer.handle_chunk((namespace, "updates", _tool_call_turn("c3", "search")))
    frames = _frames(normalizer.handle_chunk((namespace, "updates", _tool_result("c3", "search"))))

    assert {f["name"] for f in frames} == {"SUBAGENT_EVENT"}
    inner = [f["value"]["event"] for f in frames]
    [usage] = [e for e in inner if e.get("name") == "TOOL_USAGE"]
    assert usage["value"]["tool_call_id"] == "c3" and frames[0]["value"]["task_id"] == "sub-1"


def test_an_agent_run_end_to_end_reports_ok_and_failed_tools():
    @tool
    def lookup(query: str) -> str:
        """Look something up."""
        return "found it"

    @tool
    def broken(query: str) -> str:
        """Always fails."""
        raise RuntimeError("HTTP 400")

    model = StreamingFake(messages=iter([
        AIMessage(content="", tool_calls=[
            {"id": "ok-1", "name": "lookup", "args": {"query": "a"}},
            {"id": "bad-1", "name": "broken", "args": {"query": "b"}},
        ]),
        AIMessage(content="done"),
    ]))
    agent = create_agent(model=model, tools=[lookup, broken], middleware=DeepAgent._ensure_platform_middleware([]))
    normalizer = AGUIStreamNormalizer(thread_id=f"tm-{uuid4()}")

    async def run() -> list[bytes]:
        out: list[bytes] = []
        async for chunk in agent.astream({"messages": [HumanMessage(content="go")]}, stream_mode="updates"):
            out += normalizer.handle_chunk(chunk)
        return out

    usage = {f["value"]["tool_call_id"]: f["value"] for f in _frames(asyncio.run(run())) if f.get("name") == "TOOL_USAGE"}
    assert usage["ok-1"]["status"] == "ok" and usage["ok-1"]["output_chars"] == len("found it")
    assert usage["bad-1"]["status"] == "error" and usage["bad-1"]["tool_name"] == "broken"


# ------------------------------------------------------- LangGraph tool reporting
def test_the_langgraph_callback_queues_tool_calls():
    callback = UsageMetricsCallback()
    ok, failed, paused, as_message = uuid4(), uuid4(), uuid4(), uuid4()
    callback.on_tool_start({"name": "lookup"}, "q", run_id=ok)
    callback.on_tool_end("four", run_id=ok)
    callback.on_tool_start({}, "q", run_id=failed, name="fetch")
    callback.on_tool_error(RuntimeError("boom"), run_id=failed)
    callback.on_tool_start({"name": "approve"}, "q", run_id=paused)
    callback.on_tool_error(GraphInterrupt(()), run_id=paused)
    callback.on_tool_start({"name": "lookup"}, "q", run_id=as_message)
    callback.on_tool_end(ToolMessage(content="nope", tool_call_id="x", status="error"), run_id=as_message)

    calls = callback.drain_tools()
    assert [(c["tool_call_id"], c["tool_name"], c["status"], c["output_chars"]) for c in calls] == [
        (f"lg-{ok}", "lookup", "ok", 4),
        (f"lg-{failed}", "fetch", "error", 0),
        (f"lg-{as_message}", "lookup", "error", 4),
    ]
    assert all(isinstance(c["duration_ms"], int) for c in calls)
    assert callback.drain_tools() == [] and callback.drain() == []


def test_a_langgraph_agent_reports_its_tool_calls():
    @tool
    def lookup(query: str) -> str:
        """Look something up."""
        return "found it"

    async def work(config):
        await lookup.ainvoke({"query": "a"}, config)

    frames = [f["value"] for f in _run(_OneNodeAgent(work)) if f.get("name") == "TOOL_USAGE"]
    assert len(frames) == 1
    assert frames[0]["tool_call_id"].startswith("lg-") and frames[0]["tool_name"] == "lookup"
    assert frames[0]["status"] == "ok" and frames[0]["output_chars"] == len("found it")


# ------------------------------------------------------------------- the wiring
def test_every_stack_gets_tool_metrics_once_directly_outside_tool_errors():
    for stack in (None, [], [ToolErrorMiddleware()], [UsageMetricsMiddleware(), ToolErrorMiddleware()]):
        once = DeepAgent._ensure_platform_middleware(stack)
        twice = DeepAgent._ensure_platform_middleware(once)
        assert once == twice
        metrics = [i for i, m in enumerate(twice) if isinstance(m, ToolMetricsMiddleware)]
        errors = [i for i, m in enumerate(twice) if isinstance(m, ToolErrorMiddleware)]
        assert len(metrics) == 1 and len(errors) == 1 and metrics[0] == errors[0] - 1
        assert sum(isinstance(m, RetryOnRateLimitMiddleware) for m in twice) == 1
        assert sum(isinstance(m, UsageMetricsMiddleware) for m in twice) == 1


class _BareDeepAgent(DeepAgent):
    name = "inference-metrics-deep"

    def register_agent(self):
        return None


def test_build_deep_agent_guarantees_it_on_the_agent_and_every_sub_agent(monkeypatch):
    captured: dict[str, Any] = {}
    monkeypatch.setattr(deep_agent_module, "create_deep_agent", lambda **kwargs: captured.update(kwargs))
    agent = _BareDeepAgent()
    monkeypatch.setattr(agent, "_build_composite_backend", lambda: None)

    agent.build_deep_agent(
        model="openai:gpt-5",
        middleware=[],
        interrupt_on={},
        subagents=[
            {"name": "researcher", "description": "d", "system_prompt": "p"},
            {"name": "writer", "description": "d", "system_prompt": "p", "middleware": [ToolMetricsMiddleware()]},
            {"name": "compiled", "description": "d", "runnable": object()},
        ],
    )

    def count(stack):
        return sum(isinstance(m, ToolMetricsMiddleware) for m in stack)

    assert count(captured["middleware"]) == 1
    # deepagents' general-purpose sub-agent is declared by the build, first,
    # so it carries the guarantee too.
    general, researcher, writer, compiled = captured["subagents"]
    assert general["name"] == "general-purpose"
    assert count(general["middleware"]) == 1
    assert count(researcher["middleware"]) == 1 and count(writer["middleware"]) == 1
    assert "middleware" not in compiled


def test_a_deep_agent_run_carries_the_first_token_callback():
    agent = _BareDeepAgent()
    [callback] = agent._stream_config()["callbacks"]
    assert isinstance(callback, FirstTokenCallback)

    existing = object()
    agent.run_config = {"configurable": {"thread_id": "t"}, "callbacks": [existing]}
    callbacks = agent._stream_config()["callbacks"]
    assert callbacks[0] is existing and isinstance(callbacks[1], FirstTokenCallback)
    assert agent.run_config["callbacks"] == [existing]  # the run's own config is not mutated
