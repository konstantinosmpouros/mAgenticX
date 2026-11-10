"""OpenAI reasoning summaries: asked for on reasoning models, streamed as CoT thoughts."""

from __future__ import annotations

import json

import pytest
from deepagents._models import resolve_model
from langchain_core.messages import AIMessage, AIMessageChunk

from core.settings import AgentRegistrySettings, ModelInfo, ModelProfileSettings, settings
from harness.abstractions.deep_agent import model_specs
from harness.agui.normalizer import AGUIStreamNormalizer, reasoning_parts
from harness.models import reasoning_summary
from harness.models.reasoning_summary import is_reasoning_model, register_reasoning_summaries


def _payloads(frames):
    out = []
    for frame in frames:
        for line in frame.decode("utf-8").splitlines():
            if line.startswith("data:"):
                out.append(json.loads(line[len("data:"):].lstrip()))
    return out


def _thoughts(events):
    return [e["delta"] for e in events if e["type"] == "THINKING_TEXT_MESSAGE_CONTENT"]


def _summary_chunk(part: int, text: str, *, block: int = 0) -> AIMessageChunk:
    """A Responses-API reasoning-summary delta, as langchain-openai streams it."""
    return AIMessageChunk(content=[{
        "type": "reasoning",
        "index": block,
        "summary": [{"index": part, "type": "summary_text", "text": text}],
    }])


# --- settings -------------------------------------------------------------------

def test_summaries_are_on_by_default(monkeypatch):
    monkeypatch.delenv("REASONING_SUMMARY", raising=False)
    assert ModelProfileSettings().reasoning_summary == "auto"


def test_the_model_list_carries_each_model_s_facts(monkeypatch):
    monkeypatch.delenv("ALLOWED_AGENT_MODELS", raising=False)
    models = AgentRegistrySettings().allowed_agent_models
    assert list(models) == ["openai:gpt-6-luna", "openai:gpt-5", "openai:gpt-4o", "openai:gpt-4o-mini"]
    assert models["openai:gpt-6-luna"] == ModelInfo(reasoning=True, context_window=1_050_000)
    assert models["openai:gpt-4o"].reasoning is False


def test_the_model_list_reads_json_from_the_env(monkeypatch):
    monkeypatch.setenv("ALLOWED_AGENT_MODELS", '{"openai:gpt-7": {"reasoning": true, "context_window": 2000000}, "openai:gpt-4o": {}}')
    models = AgentRegistrySettings().allowed_agent_models
    assert models == {"openai:gpt-7": ModelInfo(reasoning=True, context_window=2_000_000), "openai:gpt-4o": ModelInfo()}


@pytest.mark.parametrize("raw", ["openai:a, openai:b,", '["openai:a", "openai:b"]'])
def test_the_model_list_still_accepts_bare_specs(monkeypatch, raw):
    monkeypatch.setenv("ALLOWED_AGENT_MODELS", raw)
    assert AgentRegistrySettings().allowed_agent_models == {"openai:a": ModelInfo(), "openai:b": ModelInfo()}


def test_an_unknown_model_fact_is_refused(monkeypatch):
    monkeypatch.setenv("ALLOWED_AGENT_MODELS", '{"openai:a": {"reasonning": true}}')
    with pytest.raises(ValueError):
        AgentRegistrySettings()


@pytest.mark.parametrize("mode", ["auto", "concise", "detailed", "off"])
def test_summary_modes(monkeypatch, mode):
    monkeypatch.setenv("REASONING_SUMMARY", mode)
    assert ModelProfileSettings().reasoning_summary == mode


def test_an_unknown_summary_mode_is_refused(monkeypatch):
    monkeypatch.setenv("REASONING_SUMMARY", "verbose")
    with pytest.raises(ValueError):
        ModelProfileSettings()


# --- which models ---------------------------------------------------------------

@pytest.mark.parametrize("spec, expected", [
    ("openai:gpt-5", True),
    ("openai:gpt-5-2025-08-07", True),   # dated: listed under its base name
    ("openai:o3-mini", True),
    ("openai:o4-mini", True),
    ("openai:gpt-6-luna", True),         # newer than the table: stated in ALLOWED_AGENT_MODELS
    ("openai:gpt-4o", False),
    ("openai:gpt-4o-mini", False),
    ("openai:gpt-4.1-2025-04-14", False),
    ("anthropic:claude-sonnet-4-6", False),
    ("openai:no-such-model", False),
])
def test_is_reasoning_model(spec, expected):
    assert is_reasoning_model(spec) is expected


def test_the_model_list_overrides_the_table(monkeypatch):
    monkeypatch.setitem(settings.registry.allowed_agent_models, "openai:gpt-5", ModelInfo(reasoning=False))
    assert is_reasoning_model("openai:gpt-5") is False


def test_model_specs_walk_the_whole_sub_agent_tree():
    subagents = [
        {"name": "a", "model": "openai:gpt-5", "subagents": [{"name": "a1", "model": "openai:o4-mini"}]},
        {"name": "b"},                       # inherits the parent's model
        object(),                            # a pre-compiled runnable
    ]
    assert model_specs("openai:gpt-6-luna", subagents) == {"openai:gpt-6-luna", "openai:gpt-5", "openai:o4-mini"}
    assert model_specs(object(), None) == set()


# --- the model is built with it ------------------------------------------------

def test_a_reasoning_model_is_built_asking_for_its_summary():
    register_reasoning_summaries(["openai:gpt-6-luna", "openai:gpt-4o"])
    assert resolve_model("openai:gpt-6-luna").reasoning == {"summary": settings.model_profiles.reasoning_summary}
    # A non-reasoning model would reject the parameter.
    assert resolve_model("openai:gpt-4o").reasoning is None


def test_off_asks_no_model(monkeypatch):
    monkeypatch.setattr(settings.model_profiles, "reasoning_summary", "off")
    monkeypatch.setattr(reasoning_summary, "_registered", set())
    calls = []
    monkeypatch.setattr(reasoning_summary, "register_provider_profile", lambda *a: calls.append(a))
    register_reasoning_summaries(["openai:gpt-5"])
    assert calls == []


# --- reasoning_parts ------------------------------------------------------------

def test_reasoning_parts_shapes():
    final = AIMessage(content=[
        {"type": "reasoning", "index": 0, "id": "rs_1", "encrypted_content": "gAAAA...", "summary": [
            {"index": 0, "type": "summary_text", "text": "**Plan**\n\nLook it up."},
            {"index": 1, "type": "summary_text", "text": "**Answer**\n\nKeep it short."},
        ]},
        {"type": "text", "text": "Hi!", "index": 1},
    ])
    assert reasoning_parts(final) == [("0:0", "**Plan**\n\nLook it up."), ("0:1", "**Answer**\n\nKeep it short.")]
    # Encrypted reasoning alone carries no text.
    assert reasoning_parts(AIMessage(content=[{"type": "reasoning", "summary": [], "encrypted_content": "x"}])) == []
    assert reasoning_parts(AIMessage(content=[{"type": "reasoning", "reasoning": "v1 text", "index": "r"}])) == [("r", "v1 text")]
    assert reasoning_parts(AIMessage(content=[{"type": "thinking", "thinking": "hmm", "index": 0}])) == [("0", "hmm")]
    assert reasoning_parts(AIMessage(content="plain")) == []


# --- the normalizer -------------------------------------------------------------

def test_streamed_summary_parts_become_one_thought_each_before_the_reply():
    norm = AGUIStreamNormalizer(thread_id="t-rs")
    frames = []
    for chunk in (
        AIMessageChunk(content=[{"type": "reasoning", "index": 0, "id": "rs_1", "summary": []}]),
        _summary_chunk(0, "**Plan**\n\n"), _summary_chunk(0, "Look it "), _summary_chunk(0, "up."),
        _summary_chunk(1, "**Answer**\n\nShort."),
        AIMessageChunk(content=[{"type": "text", "text": "Hi", "index": 1}]),
    ):
        frames += norm.handle_chunk(("messages", chunk))
    events = _payloads(frames)
    # One thinking phase, each part a complete thinking text message, ended
    # right before the reply's text message starts.
    assert [e["type"] for e in events] == [
        "THINKING_START",
        "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_END",
        "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_END",
        "THINKING_END",
        "TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK",
    ]
    assert _thoughts(events) == ["**Plan**\n\nLook it up.", "**Answer**\n\nShort."]

    # The final message repeats the summary: it must not be sent again.
    final = AIMessage(content=[
        {"type": "reasoning", "index": 0, "summary": [{"index": 0, "text": "**Plan**\n\nLook it up."}]},
        {"type": "text", "text": "Hi", "index": 1},
    ])
    again = _payloads(norm.handle_chunk(("updates", {"model": {"messages": [final]}})))
    assert "THINKING_TEXT_MESSAGE_CONTENT" not in [e["type"] for e in again]


def test_a_streamed_thought_goes_out_before_the_tool_call_it_led_to():
    norm = AGUIStreamNormalizer(thread_id="t-rs")
    frames = norm.handle_chunk(("messages", _summary_chunk(0, "**Search**\n\nI need the docs.")))
    assert frames == []  # held until the part is complete
    final = AIMessage(content=[{"type": "reasoning", "index": 0, "summary": [{"index": 0, "text": "**Search**\n\nI need the docs."}]}],
                      tool_calls=[{"id": "tc-1", "name": "search", "args": {"q": "docs"}}])
    events = _payloads(norm.handle_chunk(("updates", {"model": {"messages": [final]}})))
    types = [e["type"] for e in events]
    assert types[:6] == [
        "THINKING_START", "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_END",
        "TOOL_CALL_START", "TOOL_CALL_ARGS",
    ]
    assert _thoughts(events) == ["**Search**\n\nI need the docs."]


def test_updates_only_streams_send_every_part_from_the_final_message():
    norm = AGUIStreamNormalizer(thread_id="t-rs")
    final = AIMessage(content=[{"type": "reasoning", "index": 0, "summary": [
        {"index": 0, "text": "One."}, {"index": 1, "text": "Two."},
    ]}], tool_calls=[{"id": "tc-2", "name": "search", "args": {}}])
    events = _payloads(norm.handle_chunk(("updates", {"model": {"messages": [final]}})))
    thoughts = [e["delta"] for e in events if e["type"] == "THINKING_TEXT_MESSAGE_CONTENT"]
    assert thoughts == ["One.", "Two."]
    assert [e["type"] for e in events].index("TOOL_CALL_START") > 1


def test_a_re_emitted_message_sends_no_thoughts():
    norm = AGUIStreamNormalizer(thread_id="t-rs")
    final = AIMessage(content=[{"type": "reasoning", "index": 0, "summary": [{"index": 0, "text": "Old."}]}])
    events = _payloads(norm.handle_chunk(("updates", {"HumanInTheLoopMiddleware.after_model": {"messages": [final]}})))
    assert "THINKING_TEXT_MESSAGE_CONTENT" not in [e["type"] for e in events]


def test_encrypted_reasoning_alone_sends_nothing():
    norm = AGUIStreamNormalizer(thread_id="t-rs")
    chunk = AIMessageChunk(content=[{"type": "reasoning", "index": 0, "summary": [], "encrypted_content": "gAAAA"}])
    assert norm.handle_chunk(("messages", chunk)) == []
