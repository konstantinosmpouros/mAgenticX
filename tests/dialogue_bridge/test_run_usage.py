"""A run's usage, folded from TOKEN_USAGE events (migration 0032).

Pinned: input/output/cached/reasoning tokens and model time are summed over
every model call (main agent and sub-agents, each message counted once); the
context gauge's snapshot comes from the MAIN agent's latest call only — a
sub-agent runs its own, separate context and must never overwrite it.
"""
from __future__ import annotations

from utils.inference_runs import InferenceRunRuntime


def _usage(mid, *, inp, out, cached=0, reasoning=0, latency=0, context=None, window=None, model=None, compaction=None):
    value = {"message_id": mid, "input_tokens": inp, "output_tokens": out,
             "input_token_details": {"cache_read": cached}, "output_token_details": {"reasoning": reasoning},
             "latency_ms": latency}
    if context is not None:
        value.update(context_tokens=context, context_window=window, model=model, compaction_percent=compaction)
    return {"type": "CUSTOM", "name": "TOKEN_USAGE", "value": value}


def _subagent(event):
    return {"type": "CUSTOM", "name": "SUBAGENT_EVENT", "value": {"event": event}}


def test_totals_sum_every_call_and_the_context_comes_from_the_main_agents_last_call():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_usage("m1", inp=100_000, out=500, cached=80_000, reasoning=200, latency=900,
                               context=100_000, window=272_000, model="gpt-5", compaction=92.0))
    runtime.apply_event(_subagent(_usage("s1", inp=20_000, out=300, cached=0, reasoning=0, latency=400,
                                         context=20_000, window=128_000, model="gpt-4o")))
    runtime.apply_event(_usage("m2", inp=117_000, out=700, cached=100_000, reasoning=300, latency=1_100,
                               context=117_000, window=272_000, model="gpt-5", compaction=92.0))

    assert runtime.input_tokens == 237_000 and runtime.output_tokens == 1_500
    assert runtime.cached_input_tokens == 180_000 and runtime.reasoning_tokens == 500
    assert runtime.model_latency_ms == 2_400
    assert runtime.context == {"context_tokens": 117_000, "context_window": 272_000,
                               "compaction_percent": 92.0, "model_name": "gpt-5"}


def test_a_message_seen_twice_is_counted_once_and_tier_prefixed_details_count():
    runtime = InferenceRunRuntime()
    event = _usage("m1", inp=10, out=5)
    event["value"]["input_token_details"] = {"flex_cache_read": 7}
    runtime.apply_event(event)
    runtime.apply_event(_subagent(event))           # the same message, wrapped
    assert runtime.input_tokens == 10 and runtime.cached_input_tokens == 7


def test_usage_without_metrics_leaves_the_context_empty():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_usage("m1", inp=10, out=5))
    assert runtime.context == {} and runtime.model_latency_ms == 0
