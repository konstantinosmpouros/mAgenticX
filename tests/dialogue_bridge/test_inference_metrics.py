"""Inference metrics (plan 41): cost, truncation, speed, first token, tools.

Pinned:

* pricing — the lookup (exact name, then without a ``provider:`` prefix, then
  without a ``-YYYY-MM-DD`` suffix), the long-context tier chosen per call,
  cached tokens priced at the cached rate, an unknown model is unpriced
  (``None``, never 0), and the operator override from ``MODEL_PRICES_JSON`` /
  ``MODEL_PRICES_JSON_FILE`` — merged over the defaults, validated, failing
  fast on bad JSON or a negative price;
* the accumulator — truncated calls, time to first token, generation time and
  output tokens, cost and unpriced calls summed per run and per group, with a
  call seen bare and then wrapped moved to its sub-agent on every field; tool
  calls from TOOL_USAGE deduped by call id, grouped by (scope, agent, tool),
  moved the same way; the answer's first_token_ms measured by the bridge and
  left None when a HITL approval came before the first text;
* _finish_run — the answer's new columns, message_usage, tool_usage, the
  conversation's totals and the three daily rollups, added to (not replaced);
* the API — every new field of the Usage pages, the chat message and the run.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

import utils.inference_runs as ir
import utils.model_pricing as model_pricing
from core.database import (
    ConversationTable,
    MessageTable,
    MessageUsageTable,
    ToolUsageDailyTable,
    ToolUsageTable,
    UsageDailyGroupTable,
    UsageDailyTable,
)
from core.settings import PricingSettings, settings
from schema import MessageOut
from utils.inference_runs import (
    InferenceRunRuntime,
    _mark_run_completed,
    build_run_out_from_message,
)
from utils.model_pricing import call_cost_micros, lookup_price, parse_price_table

# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------


def test_cost_is_tokens_times_usd_per_million_in_micro_usd():
    assert call_cost_micros("gpt-4.1", 1_000_000, 0, 0) == 2_000_000                  # $2.00
    # 20K uncached at $1.25 + 80K cached at $0.125 + 1K output at $10 per 1M.
    assert call_cost_micros("gpt-5", 100_000, 80_000, 1_000) == 25_000 + 10_000 + 10_000
    # Rounded to whole micro-USD.
    assert call_cost_micros("gpt-4o-mini", 3, 0, 0) == 0                              # 0.45 µ$
    assert call_cost_micros("gpt-4o-mini", 10, 0, 0) == 2                             # 1.5 µ$
    # More cached tokens than input is a reporting glitch: clamped, never negative.
    assert call_cost_micros("gpt-4.1", 10, 50, 0) == 10 * 0.50


def test_lookup_tries_exact_then_without_provider_then_without_a_date():
    base = lookup_price("gpt-4.1")
    assert lookup_price("openai:gpt-4.1") is base
    assert lookup_price("gpt-4.1-2025-04-14") is base
    assert lookup_price("openai:gpt-4.1-2025-04-14") is base
    assert lookup_price("gpt-4.1-mini-2025-04-14") is lookup_price("gpt-4.1-mini") is not base
    # An exact entry wins over the stripped name.
    table = parse_price_table('{"openai:gpt-4.1": {"input": 9, "output": 9}}')
    assert call_cost_micros("openai:gpt-4.1", 1_000, 0, 0, prices=table) == 9_000
    assert call_cost_micros("azure:gpt-4.1", 1_000, 0, 0, prices=table) == 2_000


def test_the_long_context_tier_applies_above_its_threshold_per_call():
    # At the threshold: the base tier.
    assert call_cost_micros("gpt-6-luna", 272_000, 0, 0) == round(272_000 * 0.10)
    # Above it, every rate switches: input, cached and output.
    expected = round(172_001 * 0.20 + 100_000 * 0.02 + 1_000 * 0.75)
    assert call_cost_micros("gpt-6-luna", 272_001, 100_000, 1_000) == expected


def test_an_unknown_model_is_unpriced_not_free():
    assert call_cost_micros("claude-sonnet-x", 1_000, 0, 10) is None
    assert call_cost_micros(None, 1_000, 0, 10) is None
    assert call_cost_micros("", 1_000, 0, 10) is None


def test_overrides_replace_add_and_remove_prices():
    table = parse_price_table(
        '{"gpt-5": {"input": 2, "cached_input": 0.2, "output": 12},'
        ' "my-model": {"input": 1, "output": 3},'
        ' "gpt-4o": null}'
    )
    assert call_cost_micros("gpt-5", 1_000, 500, 100, prices=table) == 500 * 2 + 500 * 0.2 + 100 * 12
    # No cached_input: cached tokens cost what input costs.
    assert call_cost_micros("my-model", 1_000, 1_000, 0, prices=table) == 1_000
    assert call_cost_micros("gpt-4o", 1_000, 0, 0, prices=table) is None
    assert lookup_price("gpt-4.1", table) is not None                                 # the rest kept
    long = parse_price_table(
        '{"big": {"input": 1, "output": 2, "long_context": {"above_input_tokens": 10, "input": 5, "output": 6}}}'
    )
    assert call_cost_micros("big", 11, 11, 0, prices=long) == 11 * 5                   # cached → long input


@pytest.mark.parametrize("raw, message", [
    ("{not json", "not valid JSON"),
    ("[1, 2]", "JSON object"),
    ('{"m": {"input": -1, "output": 1}}', "non-negative"),
    ('{"m": {"input": 1, "output": "2"}}', "non-negative"),
    ('{"m": {"input": true, "output": 1}}', "non-negative"),
    ('{"m": {"input": 1}}', "required"),
    ('{"m": {"input": 1, "ouput": 1}}', "unknown price fields"),
    ('{"m": 3}', "expected an object"),
    ('{"m": {"input": 1, "output": 1, "long_context": {"input": 1, "output": 1}}}', "above_input_tokens"),
    ('{"m": {"input": 1, "output": 1, "long_context": {"above_input_tokens": 5, "input": 1, "output": -2}}}',
     "non-negative"),
])
def test_a_bad_override_is_rejected(raw, message):
    with pytest.raises(ValueError, match=message):
        parse_price_table(raw)


def test_a_bad_override_stops_the_bridge_at_startup(monkeypatch):
    monkeypatch.setattr(settings.pricing, "prices_json", '{"gpt-5": {"input": -1, "output": 1}}')
    with pytest.raises(RuntimeError, match="MODEL_PRICES_JSON is invalid"):
        model_pricing._load_configured_prices()


def test_the_override_comes_from_the_env_or_a_mounted_file(monkeypatch, tmp_path):
    monkeypatch.delenv("MODEL_PRICES_JSON_FILE", raising=False)
    monkeypatch.setenv("MODEL_PRICES_JSON", ' {"a": {"input": 1, "output": 1}} ')
    assert PricingSettings().prices_json == '{"a": {"input": 1, "output": 1}}'
    # The *_FILE convention: a mounted file wins over the plain variable.
    path = tmp_path / "prices.json"
    path.write_text('{"b": {"input": 2, "output": 2}}', encoding="utf-8")
    monkeypatch.setenv("MODEL_PRICES_JSON_FILE", str(path))
    assert "b" in parse_price_table(PricingSettings().prices_json)
    monkeypatch.setenv("MODEL_PRICES_JSON_FILE", str(tmp_path / "missing.json"))
    with pytest.raises(RuntimeError, match="MODEL_PRICES_JSON_FILE"):
        PricingSettings()
    monkeypatch.delenv("MODEL_PRICES_JSON_FILE")
    monkeypatch.delenv("MODEL_PRICES_JSON")
    assert PricingSettings().prices_json == ""


# ---------------------------------------------------------------------------
# The accumulator
# ---------------------------------------------------------------------------
def _usage(mid, model="gpt-5", *, inp=0, out=0, cached=0, latency=0, ttft=None, truncated=False):
    value = {"message_id": mid, "model": model, "input_tokens": inp, "output_tokens": out,
             "input_token_details": {"cache_read": cached}, "latency_ms": latency,
             "finish_reason": "length" if truncated else "stop", "truncated": truncated}
    if ttft is not None:
        value["ttft_ms"] = ttft
    return {"type": "CUSTOM", "name": "TOKEN_USAGE", "value": value}


def _tool(call_id, name, *, ms=0, chars=0, status="ok"):
    return {"type": "CUSTOM", "name": "TOOL_USAGE", "value": {
        "tool_call_id": call_id, "tool_name": name, "duration_ms": ms, "status": status, "output_chars": chars}}


def _subagent(event, task_id="task-1"):
    return {"type": "CUSTOM", "name": "SUBAGENT_EVENT", "value": {"task_id": task_id, "event": event}}


def _task(task_id, subagent_type):
    return {"type": "CUSTOM", "name": "TASK_SUBAGENT", "value": {"task_id": task_id, "subagent_type": subagent_type}}


def _text(delta):
    return {"type": "TEXT_MESSAGE_CONTENT", "messageId": "run", "delta": delta}


def _interrupt(interrupt_id="i-1"):
    return {"type": "CUSTOM", "name": "HITL_INTERRUPT", "value": {"interrupt": {"id": interrupt_id}}}


def _metrics(source) -> dict:
    return {name: (source[name] if isinstance(source, dict) else getattr(source, name)) for name in (
        "cost_micros", "unpriced_calls", "truncated_calls", "ttft_ms", "ttft_calls", "gen_ms", "gen_output_tokens")}


def test_cost_truncation_and_speed_are_summed_per_call():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_usage("m1", inp=1_000, out=100, latency=2_000, ttft=500))
    runtime.apply_event(_usage("m2", inp=2_000, out=300, latency=1_000, ttft=1_200, truncated=True))
    runtime.apply_event(_usage("m3", "mystery-model", inp=10, out=1, latency=50))      # did not stream
    runtime.apply_event(_usage("m2", inp=2_000, out=300, latency=1_000, ttft=1_200, truncated=True))  # replay

    assert _metrics(runtime) == {
        "cost_micros": (1_000 * 1.25 + 100 * 10) + (2_000 * 1.25 + 300 * 10),
        "unpriced_calls": 1,
        "truncated_calls": 1,
        "ttft_ms": 500 + 1_200,
        "ttft_calls": 2,
        # Time after the first token; a ttft past the call's latency adds 0, never less.
        "gen_ms": 1_500 + 0,
        # Only the streamed calls' output: tokens/s never mixes in a non-streamed call.
        "gen_output_tokens": 100 + 300,
    }
    assert _metrics(runtime.usage_groups[("main", "", "gpt-5")])["ttft_calls"] == 2
    assert runtime.usage_groups[("main", "", "mystery-model")]["unpriced_calls"] == 1


def test_a_call_seen_bare_then_wrapped_moves_every_metric_to_its_subagent():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_task("task-1", "researcher"))
    bare = _usage("s1", "gpt-4.1", inp=300, out=50, latency=900, ttft=100, truncated=True)
    runtime.apply_event(bare)
    runtime.apply_event(_subagent(bare))

    assert list(runtime.usage_groups) == [("subagent", "researcher", "gpt-4.1")]
    moved = _metrics(runtime.usage_groups[("subagent", "researcher", "gpt-4.1")])
    assert moved == {"cost_micros": 300 * 2 + 50 * 8, "unpriced_calls": 0, "truncated_calls": 1,
                     "ttft_ms": 100, "ttft_calls": 1, "gen_ms": 800, "gen_output_tokens": 50}
    assert moved == _metrics(runtime)                                                   # counted once


def test_tool_calls_are_deduped_grouped_and_moved_to_their_subagent():
    runtime = InferenceRunRuntime()
    runtime.apply_event(_task("task-1", "researcher"))
    runtime.apply_event(_tool("t1", "read_file", ms=100, chars=500))
    runtime.apply_event(_tool("t1", "read_file", ms=100, chars=500))                   # replayed
    runtime.apply_event(_tool("t2", "write_file", ms=50, status="error"))
    runtime.apply_event(_subagent(_tool("t3", "web_search", ms=2_000, chars=8_000)))
    bare = _tool("t4", "web_search", ms=300, chars=100, status="error")
    runtime.apply_event(bare)
    runtime.apply_event(_subagent(bare))
    runtime.apply_event(_subagent(_tool("t5", "web_search", ms=10), "unbound-task"))

    assert runtime.tool_groups == {
        ("main", "", "read_file"): {"calls": 1, "errors": 0, "duration_ms": 100, "output_chars": 500},
        ("main", "", "write_file"): {"calls": 1, "errors": 1, "duration_ms": 50, "output_chars": 0},
        ("subagent", "researcher", "web_search"): {"calls": 2, "errors": 1, "duration_ms": 2_300,
                                                   "output_chars": 8_100},
        ("subagent", "sub-agent", "web_search"): {"calls": 1, "errors": 0, "duration_ms": 10, "output_chars": 0},
    }


def test_first_token_is_the_main_agents_first_text_since_the_run_started():
    runtime = InferenceRunRuntime()
    runtime.started_at -= 1.5                                       # the run began 1.5 s ago
    runtime.apply_event(_usage("m1", inp=10, out=1))
    runtime.apply_event(_text(""))                                  # empty: not a token
    runtime.apply_event(_subagent(_text("a sub-agent's words")))    # not the answer's text
    assert runtime.first_token_ms is None
    runtime.apply_event(_text("Hello"))
    first = runtime.first_token_ms
    assert first is not None and 1_500 <= first < 1_500 + 5_000
    runtime.apply_event(_text(" world"))
    assert runtime.first_token_ms == first                          # settled once


def test_an_approval_before_the_first_text_leaves_first_token_unmeasured():
    paused = InferenceRunRuntime()
    paused.apply_event(_interrupt())
    paused.resolve_interrupt("i-1")                                 # the resume leg
    paused.apply_event(_text("Done."))
    assert paused.first_token_ms is None

    # A sub-agent's approval counts too (it reaches the bridge wrapped as well).
    wrapped = InferenceRunRuntime()
    wrapped.apply_event(_subagent({"type": "CUSTOM", "name": "HITL_INTERRUPT", "value": {"interrupt": {"id": "x"}}}))
    wrapped.apply_event(_text("Done."))
    assert wrapped.first_token_ms is None

    # After the first text, an approval changes nothing.
    answered = InferenceRunRuntime()
    answered.apply_event(_text("Let me check."))
    answered.apply_event(_interrupt())
    assert answered.first_token_ms is not None

    assert InferenceRunRuntime().first_token_ms is None             # no text at all


# ---------------------------------------------------------------------------
# _finish_run and the API
# ---------------------------------------------------------------------------
@pytest.fixture
def patch_session_local(monkeypatch, session_factory):
    """Route _finish_run's own SessionLocal() at the test database; the
    background capture of written files is another feature's, not run here."""
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    monkeypatch.setattr(ir, "schedule_remaining_capture", lambda *args, **kwargs: None)
    return session_factory


async def _conversation(session_factory, user, agent) -> str:
    async with session_factory() as session:
        conversation = ConversationTable(user_id=user.id, agent_id=agent.id, agent_name=agent.name, title="Metrics",
                                         is_private=False)
        session.add(conversation)
        await session.commit()
        return conversation.id


async def _start_run(session_factory, conversation_id, agent) -> str:
    async with session_factory() as session:
        run = MessageTable(conversation_id=conversation_id, sender="ai", content="", agent_id=agent.id,
                           agent_name=agent.name, streaming_status="running", streaming_started_at=ir._now(),
                           created_at=ir._now())
        session.add(run)
        await session.commit()
        return run.id


def _first_answer() -> InferenceRunRuntime:
    runtime = InferenceRunRuntime()
    runtime.apply_event(_usage("m1", inp=1_000, out=100, latency=2_000, ttft=500))
    runtime.apply_event(_task("task-1", "researcher"))
    runtime.apply_event(_subagent(_usage("s1", "gpt-4.1", inp=300, out=50, latency=900, ttft=100, truncated=True)))
    runtime.apply_event(_subagent(_usage("s2", "mystery-model", inp=10, out=1)))
    runtime.apply_event(_tool("t1", "read_file", ms=100, chars=500))
    runtime.apply_event(_subagent(_tool("t2", "read_file", ms=40, chars=60, status="error")))
    runtime.apply_event(_subagent(_tool("t3", "web_search", ms=2_000, chars=8_000)))
    runtime.apply_event(_text("Here is what I found."))
    return runtime


FIRST_COST = (1_000 * 1.25 + 100 * 10) + (300 * 2 + 50 * 8)        # 2250 + 1000


async def test_finishing_a_run_books_every_metric_everywhere(
    patch_session_local, session_factory, seeded_user, seeded_agent
):
    conversation_id = await _conversation(session_factory, seeded_user, seeded_agent)
    first_id = await _start_run(session_factory, conversation_id, seeded_agent)
    first = _first_answer()
    await _mark_run_completed(first_id, first)

    second_id = await _start_run(session_factory, conversation_id, seeded_agent)
    second = InferenceRunRuntime()
    second.apply_event(_interrupt())                                # approval first: no first token
    second.apply_event(_usage("m2", inp=2_000, out=10, latency=700))
    second.apply_event(_tool("t9", "read_file", ms=10, chars=5))
    await _mark_run_completed(second_id, second)

    async with session_factory() as session:
        answer = await session.get(MessageTable, first_id)
        assert _metrics(answer) == {"cost_micros": FIRST_COST, "unpriced_calls": 1, "truncated_calls": 1,
                                    "ttft_ms": 600, "ttft_calls": 2, "gen_ms": 1_500 + 800,
                                    "gen_output_tokens": 150}
        assert answer.first_token_ms == first.first_token_ms is not None
        later = await session.get(MessageTable, second_id)
        assert later.first_token_ms is None and later.ttft_calls == 0 and later.cost_micros == 2_000 * 1.25 + 100

        usage = {(r.scope, r.agent_name, r.model_name): r for r in (await session.execute(
            select(MessageUsageTable).where(MessageUsageTable.message_id == first_id))).scalars()}
        assert usage[("main", seeded_agent.name, "gpt-5")].cost_micros == 2_250
        assert _metrics(usage[("subagent", "researcher", "gpt-4.1")]) == {
            "cost_micros": 1_000, "unpriced_calls": 0, "truncated_calls": 1, "ttft_ms": 100, "ttft_calls": 1,
            "gen_ms": 800, "gen_output_tokens": 50}
        assert usage[("subagent", "researcher", "mystery-model")].unpriced_calls == 1

        tools = {(r.scope, r.agent_name, r.tool_name): (r.calls, r.errors, r.duration_ms, r.output_chars)
                 for r in (await session.execute(
                     select(ToolUsageTable).where(ToolUsageTable.message_id == first_id))).scalars()}
        assert tools == {
            ("main", seeded_agent.name, "read_file"): (1, 0, 100, 500),
            ("subagent", "researcher", "read_file"): (1, 1, 40, 60),
            ("subagent", "researcher", "web_search"): (1, 0, 2_000, 8_000),
        }

        conversation = await session.get(ConversationTable, conversation_id)
        assert conversation.usage_cost_micros == FIRST_COST + 2_600
        assert conversation.usage_truncated_calls == 1

        [day] = (await session.execute(select(UsageDailyTable))).scalars().all()
        assert (day.cost_micros, day.unpriced_calls, day.truncated_calls) == (FIRST_COST + 2_600, 1, 1)
        # Only the measured answer adds to the first-token average.
        assert (day.first_token_ms, day.first_token_answers) == (first.first_token_ms, 1)
        groups = {(g.scope, g.group_name, g.model_name): g
                  for g in (await session.execute(select(UsageDailyGroupTable))).scalars()}
        assert _metrics(groups[("main", seeded_agent.name, "gpt-5")]) == {
            "cost_micros": 2_250 + 2_600, "unpriced_calls": 0, "truncated_calls": 0, "ttft_ms": 500,
            "ttft_calls": 1, "gen_ms": 1_500, "gen_output_tokens": 100}
        assert groups[("subagent", "researcher", "gpt-4.1")].truncated_calls == 1

        # The tool rollup: per main agent and tool, a sub-agent's calls included, both answers added.
        daily_tools = {r.tool_name: (r.calls, r.errors, r.duration_ms, r.output_chars, r.agent_id)
                       for r in (await session.execute(select(ToolUsageDailyTable))).scalars()}
        assert daily_tools == {
            "read_file": (3, 1, 150, 565, seeded_agent.id),
            "web_search": (1, 0, 2_000, 8_000, seeded_agent.id),
        }

        # The chat message and the run carry the answer's figures.
        message = MessageOut.model_validate(await ir._load_message(session, first_id)).model_dump()
        run = build_run_out_from_message(answer, user_id=seeded_user.id).model_dump()
        for out in (message, run):
            assert (out["costMicros"], out["unpricedCalls"], out["truncatedCalls"]) == (FIRST_COST, 1, 1)
            assert (out["ttftMs"], out["ttftCalls"], out["genMs"], out["genOutputTokens"]) == (600, 2, 2_300, 150)
            assert out["firstTokenMs"] == first.first_token_ms


async def test_a_run_that_spent_nothing_records_no_metrics(
    patch_session_local, session_factory, seeded_user, seeded_agent
):
    conversation_id = await _conversation(session_factory, seeded_user, seeded_agent)
    run_id = await _start_run(session_factory, conversation_id, seeded_agent)
    runtime = InferenceRunRuntime()
    runtime.apply_event(_tool("t1", "read_file", ms=5))
    await _mark_run_completed(run_id, runtime)
    async with session_factory() as session:
        answer = await session.get(MessageTable, run_id)
        assert set(_metrics(answer).values()) == {None} and answer.first_token_ms is None
        assert (await session.execute(select(ToolUsageTable))).scalars().all() == []
        assert (await session.execute(select(ToolUsageDailyTable))).scalars().all() == []


async def test_the_usage_pages_carry_cost_speed_truncation_and_tools(
    client, patch_session_local, session_factory, seeded_user, seeded_agent
):
    conversation_id = await _conversation(session_factory, seeded_user, seeded_agent)
    first_id = await _start_run(session_factory, conversation_id, seeded_agent)
    first = _first_answer()
    await _mark_run_completed(first_id, first)
    base = f"/v1/usage/{seeded_user.id}"

    summary = (await client.get(f"{base}/summary")).json()
    for window in (summary["totals"], summary["today"], summary["last7Days"], summary["daily"][0]):
        assert (window["costMicros"], window["unpricedCalls"], window["truncatedCalls"]) == (FIRST_COST, 1, 1)
        assert (window["firstTokenMs"], window["firstTokenAnswers"]) == (first.first_token_ms, 1)
    assert summary["previous7Days"]["costMicros"] == 0
    models = {m["model"]: m for m in summary["perModel"]}
    assert (models["gpt-5"]["costMicros"], models["gpt-5"]["ttftMs"], models["gpt-5"]["ttftCalls"]) == (2_250, 500, 1)
    assert (models["gpt-5"]["genMs"], models["gpt-5"]["genOutputTokens"]) == (1_500, 100)
    assert models["gpt-4.1"]["truncatedCalls"] == 1 and models["mystery-model"]["unpricedCalls"] == 1
    assert summary["perAgent"][0]["costMicros"] == FIRST_COST
    assert summary["perTool"] == [
        {"toolName": "read_file", "calls": 2, "errors": 1, "durationMs": 140, "outputChars": 560},
        {"toolName": "web_search", "calls": 1, "errors": 0, "durationMs": 2_000, "outputChars": 8_000},
    ]

    [row] = (await client.get(f"{base}/conversations")).json()["items"]
    assert (row["costMicros"], row["truncatedCalls"]) == (FIRST_COST, 1)

    detail = (await client.get(f"{base}/conversations/{conversation_id}")).json()
    assert (detail["costMicros"], detail["unpricedCalls"], detail["truncatedCalls"]) == (FIRST_COST, 1, 1)
    assert [t["toolName"] for t in detail["tools"]] == ["read_file", "web_search"]
    groups = {(g["scope"], g["model"]): g for g in detail["groups"]}
    assert groups[("subagent", "gpt-4.1")]["ttftCalls"] == 1 and groups[("main", "gpt-5")]["costMicros"] == 2_250
    point = detail["branch"][-1]
    assert (point["costMicros"], point["unpricedCalls"], point["truncatedCalls"]) == (FIRST_COST, 1, 1)
    assert point["firstTokenMs"] == first.first_token_ms

    [entity] = (await client.get(f"{base}/agents", params={"range": "all"})).json()["items"]
    assert (entity["costMicros"], entity["truncatedCalls"]) == (FIRST_COST, 1)
    profile = (await client.get(f"{base}/agents/{seeded_agent.id}", params={"range": "7d"})).json()
    assert profile["agent"]["costMicros"] == FIRST_COST
    assert [(t["toolName"], t["calls"]) for t in profile["tools"]] == [("read_file", 2), ("web_search", 1)]
    assert {g["model"]: g["costMicros"] for g in profile["groups"]}["gpt-4.1"] == 1_000
    assert profile["daily"][0]["firstTokenAnswers"] == 1
