"""Model-call middleware: waiting out rate limits, and reporting truncated replies.

Pinned:

* a 429 is retried after a wait, up to ``max_attempts`` attempts in all, and
  the call's answer is returned as if nothing happened;
* the wait is the configured delay, or the provider's ``Retry-After`` when that
  is larger, never past the cap;
* ``insufficient_quota`` (out of credit) and every non-429 error are raised at
  once, never retried;
* every deep agent and every sub-agent gets the retry exactly once, outermost,
  so the usage stamp times only the attempt that answered;
* ``finish_reason`` is read from Chat Completions, Anthropic-style and
  Responses-API metadata, and ``truncated`` is set only for an output-cap stop;
* both reach the ``TOKEN_USAGE`` event, for deep agents (middleware) and
  LangGraph agents (run callback) alike.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from harness.abstractions.deep_agent import DeepAgent
from harness.agui.emitter import AGUIEmitter
from harness.agui.usage_callback import UsageMetricsCallback, finish_reason_from_result
from harness.middlewares import (
    RetryOnRateLimitMiddleware,
    ToolErrorMiddleware,
    UsageMetricsMiddleware,
)
from harness.middlewares.rate_limit import is_rate_limit_error, retry_after_seconds
from harness.middlewares.usage_metrics import METRICS_KEY, finish_reason


class RateLimitError(Exception):
    """Stands in for openai.RateLimitError: matched by name, carries the response."""

    def __init__(self, *, retry_after: str | None = None, code: str | None = None):
        super().__init__("429 Too Many Requests")
        self.code = code
        self.status_code = 429
        headers = {"retry-after": retry_after} if retry_after is not None else {}
        self.response = SimpleNamespace(status_code=429, headers=headers)


class Flaky:
    """A model-call handler that fails ``failures`` times, then answers."""

    def __init__(self, failures: int, error_factory=lambda: RateLimitError()):
        self.failures = failures
        self.error_factory = error_factory
        self.calls = 0

    async def __call__(self, _request):
        self.calls += 1
        if self.calls <= self.failures:
            raise self.error_factory()
        return "answer"


@pytest.fixture
def no_sleep(monkeypatch):
    """Record the waits instead of sleeping through them."""
    waits: list[float] = []

    async def fake_sleep(seconds):
        waits.append(seconds)

    monkeypatch.setattr("harness.middlewares.rate_limit.asyncio.sleep", fake_sleep)
    return waits


def _retry(**kwargs) -> RetryOnRateLimitMiddleware:
    return RetryOnRateLimitMiddleware(**{"max_attempts": 4, "delay_seconds": 15.0, "max_delay_seconds": 120.0, **kwargs})


# ---------------------------------------------------------------- rate limits
def test_a_rate_limited_call_is_retried_until_it_answers(no_sleep):
    handler = Flaky(failures=2)
    result = asyncio.run(_retry().awrap_model_call(SimpleNamespace(), handler))
    assert result == "answer"
    assert handler.calls == 3
    assert no_sleep == [15.0, 15.0]


def test_the_retry_gives_up_after_max_attempts(no_sleep):
    handler = Flaky(failures=10)
    with pytest.raises(RateLimitError):
        asyncio.run(_retry(max_attempts=3).awrap_model_call(SimpleNamespace(), handler))
    assert handler.calls == 3
    assert len(no_sleep) == 2


def test_a_larger_retry_after_wins_but_is_capped(no_sleep):
    middleware = _retry()
    assert middleware.delay_for(RateLimitError(retry_after="40")) == 40.0
    assert middleware.delay_for(RateLimitError(retry_after="3")) == 15.0
    assert middleware.delay_for(RateLimitError(retry_after="600")) == 120.0
    assert middleware.delay_for(RateLimitError(retry_after="Wed, 21 Oct 2026 07:28:00 GMT")) == 15.0


def test_out_of_credit_and_other_errors_are_raised_at_once(no_sleep):
    out_of_credit = Flaky(failures=1, error_factory=lambda: RateLimitError(code="insufficient_quota"))
    with pytest.raises(RateLimitError):
        asyncio.run(_retry().awrap_model_call(SimpleNamespace(), out_of_credit))
    assert out_of_credit.calls == 1

    broken = Flaky(failures=1, error_factory=lambda: ValueError("bad request"))
    with pytest.raises(ValueError):
        asyncio.run(_retry().awrap_model_call(SimpleNamespace(), broken))
    assert broken.calls == 1
    assert no_sleep == []


def test_a_429_is_recognised_by_class_name_or_status_code():
    assert is_rate_limit_error(RateLimitError())
    by_status = Exception("busy")
    by_status.response = SimpleNamespace(status_code=429, headers={})
    assert is_rate_limit_error(by_status)
    assert not is_rate_limit_error(RuntimeError("boom"))
    assert not is_rate_limit_error(RateLimitError(code="insufficient_quota"))
    assert retry_after_seconds(RuntimeError("no response")) is None


def test_the_sync_path_retries_too(monkeypatch):
    waits: list[float] = []
    monkeypatch.setattr("harness.middlewares.rate_limit.time.sleep", waits.append)
    calls = {"n": 0}

    def handler(_request):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RateLimitError(retry_after="20")
        return "answer"

    assert _retry().wrap_model_call(SimpleNamespace(), handler) == "answer"
    assert waits == [20.0]


def test_every_deep_agent_and_sub_agent_gets_the_retry_once_and_outermost():
    stack = DeepAgent._ensure_rate_limit_middleware([ToolErrorMiddleware(), UsageMetricsMiddleware()])
    assert isinstance(stack[0], RetryOnRateLimitMiddleware)
    again = DeepAgent._ensure_rate_limit_middleware(stack)
    assert sum(isinstance(m, RetryOnRateLimitMiddleware) for m in again) == 1
    assert DeepAgent._ensure_rate_limit_middleware(None)[0].__class__ is RetryOnRateLimitMiddleware


# ----------------------------------------------------------------- truncation
@pytest.mark.parametrize(
    ("metadata", "expected"),
    [
        ({"finish_reason": "stop"}, "stop"),
        ({"finish_reason": "length"}, "length"),
        ({"stop_reason": "max_tokens"}, "max_tokens"),
        ({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}, "max_output_tokens"),
        ({}, None),
        (None, None),
    ],
)
def test_finish_reason_is_read_from_every_api_shape(metadata, expected):
    assert finish_reason(metadata) == expected


def _stamp(reply: AIMessage) -> dict:
    async def handler(_request):
        return SimpleNamespace(result=[reply])

    model = SimpleNamespace(model_name="gpt-5", profile={"max_input_tokens": 272_000})
    asyncio.run(UsageMetricsMiddleware().awrap_model_call(SimpleNamespace(model=model), handler))
    return reply.response_metadata[METRICS_KEY]


def _reply(**metadata) -> AIMessage:
    return AIMessage(
        content="partial",
        usage_metadata={"input_tokens": 1000, "output_tokens": 16000, "total_tokens": 17000},
        response_metadata=metadata,
    )


def test_a_reply_cut_off_at_the_output_cap_is_marked_truncated():
    metrics = _stamp(_reply(finish_reason="length"))
    assert metrics["finish_reason"] == "length"
    assert metrics["truncated"] is True


def test_a_reply_that_finished_normally_is_not_truncated():
    metrics = _stamp(_reply(finish_reason="tool_calls"))
    assert metrics["finish_reason"] == "tool_calls"
    assert metrics["truncated"] is False


def test_no_finish_reason_means_no_claim_either_way():
    metrics = _stamp(_reply())
    assert "finish_reason" not in metrics
    assert "truncated" not in metrics


def test_finish_reason_and_truncation_reach_the_token_usage_event():
    reply = _reply(finish_reason="length")
    metrics = _stamp(reply)
    event = AGUIEmitter().token_usage(reply.usage_metadata, message_id="m1", metrics=metrics)
    # Without a writer the emitter returns the SSE frame: `data: {...}`.
    frame = event.decode() if isinstance(event, (bytes, bytearray)) else str(event)
    payload = json.loads(frame.split("data:", 1)[1].strip())["value"]
    assert payload["finish_reason"] == "length"
    assert payload["truncated"] is True


def test_a_langgraph_agent_reports_truncation_through_its_callback():
    callback = UsageMetricsCallback()
    run_id = uuid4()
    asyncio.run(callback.on_chat_model_start({}, [[]], run_id=run_id, metadata={"ls_model_name": "gpt-4o"}))
    result = LLMResult(
        generations=[[ChatGeneration(message=_reply(), generation_info={"finish_reason": "length"})]]
    )
    assert finish_reason_from_result(result) == "length"
    asyncio.run(callback.on_llm_end(result, run_id=run_id))
    [(_usage, _call_id, metrics)] = callback.drain()
    assert metrics["finish_reason"] == "length"
    assert metrics["truncated"] is True
