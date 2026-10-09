"""UsageMetricsMiddleware: which model ran, how long it took, how full its context was.

Pinned:

* the context window comes from the model's own profile, and a dated snapshot
  (``gpt-5-2025-08-07``) falls back to its base model's profile;
* occupancy is the provider-reported prompt size over that window;
* the "compacts at" marker appears only when a summarizer is really there;
* a reply in an unexpected shape is passed through, never failed;
* the metrics reach the ``TOKEN_USAGE`` event;
* every deep agent and every sub-agent gets the middleware exactly once;
* a LangGraph agent (plan 33), whose chains never reach the normalizer, reports
  every chat-model call as a ``TOKEN_USAGE`` frame through its run callback —
  including calls a node makes without passing its config on.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import TypedDict
from uuid import uuid4

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult
from langgraph.graph import END, START

from harness.abstractions.deep_agent import DeepAgent
from harness.abstractions.langgraph_agent import LangGraphAgent
from harness.agui.usage_callback import UsageMetricsCallback, usage_from_result
from harness.agui.emitter import AGUIEmitter
from harness.middlewares import ConfigurableSummarizationMiddleware, UsageMetricsMiddleware
from harness.middlewares.usage_metrics import METRICS_KEY, context_window, model_name


class FakeModel:
    def __init__(self, name: str, window: int | None):
        self.model_name = name
        self.profile = {"max_input_tokens": window} if window else None


def _reply(prompt_tokens: int = 117_000) -> AIMessage:
    return AIMessage(
        content="ok",
        usage_metadata={"input_tokens": prompt_tokens, "output_tokens": 50, "total_tokens": prompt_tokens + 50},
    )


def _call(middleware: UsageMetricsMiddleware, model, reply) -> dict:
    async def handler(_request):
        return SimpleNamespace(result=[reply])

    asyncio.run(middleware.awrap_model_call(SimpleNamespace(model=model), handler))
    return reply.response_metadata.get(METRICS_KEY, {})


def test_the_window_comes_from_the_profile_and_dated_names_fall_back_to_their_base():
    assert context_window(FakeModel("gpt-5", 272_000)) == 272_000
    assert context_window(FakeModel("gpt-5-2025-08-07", None)) == 272_000      # base model's profile
    assert context_window(FakeModel("gpt-4.1-2025-04-14", None)) == 1_047_576
    assert context_window(FakeModel("some-unknown-model", None)) is None
    assert model_name(SimpleNamespace(model="gpt-4o")) == "gpt-4o"


def test_a_call_is_stamped_with_model_latency_and_occupancy():
    metrics = _call(UsageMetricsMiddleware(compaction_fraction=0.92), FakeModel("gpt-5", 272_000), _reply(117_000))

    assert metrics["model"] == "gpt-5"
    assert metrics["context_window"] == 272_000
    assert metrics["context_tokens"] == 117_000
    assert metrics["context_percent"] == 43.0
    assert metrics["compaction_percent"] == 92.0
    assert isinstance(metrics["latency_ms"], int) and metrics["latency_ms"] >= 0


def test_no_compaction_marker_without_a_summarizer_and_no_percent_without_a_window():
    metrics = _call(UsageMetricsMiddleware(), FakeModel("mystery", None), _reply(1_000))
    assert "compaction_percent" not in metrics and "context_percent" not in metrics
    assert metrics["context_tokens"] == 1_000 and metrics["context_window"] is None


def test_an_unexpected_reply_shape_is_passed_through():
    async def handler(_request):
        return "not a model response"

    result = asyncio.run(UsageMetricsMiddleware().awrap_model_call(SimpleNamespace(model=None), handler))
    assert result == "not a model response"


def test_the_metrics_ride_the_token_usage_event():
    event = AGUIEmitter().token_usage(
        {"input_tokens": 117_000, "output_tokens": 50, "total_tokens": 117_050},
        message_id="m1",
        metrics={"model": "gpt-5", "latency_ms": 900, "context_window": 272_000,
                 "context_tokens": 117_000, "context_percent": 43.0, "compaction_percent": 92.0},
    )
    # Without a writer the emitter returns the SSE frame: `data: {...}`.
    frame = event.decode() if isinstance(event, (bytes, bytearray)) else str(event)
    payload = json.loads(frame.split("data:", 1)[1].strip())
    value = payload["value"]
    assert payload["name"] == "TOKEN_USAGE"
    assert value["model"] == "gpt-5" and value["context_percent"] == 43.0 and value["latency_ms"] == 900


@pytest.mark.parametrize("with_summarizer", [True, False])
def test_every_stack_gets_the_middleware_exactly_once(with_summarizer):
    summarizer = ConfigurableSummarizationMiddleware.__new__(ConfigurableSummarizationMiddleware)
    stack = [summarizer] if with_summarizer else []

    once = DeepAgent._ensure_usage_metrics_middleware(stack)
    twice = DeepAgent._ensure_usage_metrics_middleware(once)

    added = [m for m in twice if isinstance(m, UsageMetricsMiddleware)]
    assert len(added) == 1
    assert (added[0].compaction_fraction is not None) is with_summarizer


def _frames(chunks: list[bytes]) -> list[dict]:
    """The JSON payloads of a list of SSE frames."""
    return [json.loads(c.decode().split("data:", 1)[1].strip()) for c in chunks]


def test_usage_is_read_from_the_message_or_from_llm_output():
    message = AIMessage(content="ok", usage_metadata={"input_tokens": 12, "output_tokens": 3, "total_tokens": 15})
    assert usage_from_result(LLMResult(generations=[[ChatGeneration(message=message)]]))["input_tokens"] == 12

    bare = LLMResult(generations=[[ChatGeneration(message=AIMessage(content="ok"))]], llm_output={"token_usage": {
        "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
        "prompt_tokens_details": {"cached_tokens": 64}, "completion_tokens_details": {"reasoning_tokens": 8},
    }})
    usage = usage_from_result(bare)
    assert usage["input_token_details"] == {"cache_read": 64} and usage["output_token_details"] == {"reasoning": 8}
    assert usage_from_result(LLMResult(generations=[[ChatGeneration(message=AIMessage(content="ok"))]])) is None


def test_the_callback_times_each_call_and_forgets_failed_ones():
    callback = UsageMetricsCallback()
    call, failed = uuid4(), uuid4()

    async def scenario():
        await callback.on_chat_model_start({}, [[]], run_id=call, metadata={"ls_model_name": "gpt-4.1"})
        await callback.on_chat_model_start({}, [[]], run_id=failed, invocation_params={"model": "gpt-5"})
        await callback.on_llm_error(RuntimeError("boom"), run_id=failed)
        message = AIMessage(content="ok", usage_metadata={"input_tokens": 5, "output_tokens": 1, "total_tokens": 6})
        await callback.on_llm_end(LLMResult(generations=[[ChatGeneration(message=message)]]), run_id=call)

    asyncio.run(scenario())
    [(usage, call_id, metrics)] = callback.drain()
    assert usage["input_tokens"] == 5 and call_id == f"lg-{call}"
    assert metrics["model"] == "gpt-4.1" and metrics["latency_ms"] >= 0
    assert callback.drain() == []


class _State(TypedDict, total=False):
    done: bool


class _PipelineAgent(LangGraphAgent):
    """Two model calls in one node — one passes its config, one does not."""

    name = "usage-test-pipeline"

    def __init__(self, model):
        super().__init__(config={"run_config": {"configurable": {"thread_id": "usage-test"}}})
        self.state = _State
        self._model = model

    def _durable_checkpointer(self):
        return None

    def register_agents(self):
        return self._model

    def register_nodes(self):
        async def answer(state, config):
            await self.agents.ainvoke("first", config)
            await self.agents.ainvoke("second")
            return {"done": True}
        return answer

    def register_graph_nodes(self, graph):
        graph.add_node("answer", self.nodes)
        return graph

    def register_graph_edges(self, graph):
        graph.add_edge(START, "answer")
        graph.add_edge("answer", END)
        return graph


def test_a_langgraph_agent_reports_every_model_call():
    def reply(tokens: int) -> AIMessage:
        return AIMessage(content="ok", usage_metadata={"input_tokens": tokens, "output_tokens": 2,
                                                         "total_tokens": tokens + 2})

    agent = _PipelineAgent(GenericFakeChatModel(messages=iter([reply(300), reply(40)])))

    async def run() -> list[bytes]:
        return [chunk async for chunk in agent.astream({})]

    frames = [f for f in _frames(asyncio.run(run())) if f.get("name") == "TOKEN_USAGE"]
    assert [f["value"]["input_tokens"] for f in frames] == [300, 40]
    assert all(f["value"]["message_id"].startswith("lg-") for f in frames)
    assert len({f["value"]["message_id"] for f in frames}) == 2

