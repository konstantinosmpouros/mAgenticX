"""UsageMetricsMiddleware: which model ran, how long it took, how full its context was.

Pinned:

* the context window comes from the model's own profile, and a dated snapshot
  (``gpt-5-2025-08-07``) falls back to its base model's profile;
* occupancy is the provider-reported prompt size over that window;
* the "compacts at" marker appears only when a summarizer is really there;
* a reply in an unexpected shape is passed through, never failed;
* the metrics reach the ``TOKEN_USAGE`` event;
* every deep agent and every sub-agent gets the middleware exactly once.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage

from harness.abstractions.deep_agent import DeepAgent
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
