"""``SourcesMiddleware``, the ``SOURCES`` event and the citing prompt (plan 42).

Pinned:

* the model sees ``[src:ID]`` beside each page, the result carries the
  ``mx_sources`` stamp, and the run's conversation keeps the sources;
* a tool without an extractor, an error result and a run without a
  conversation are handled without surprises — and a store that fails or
  hangs never fails the tool call;
* every stack the run builds (main agent, sub-agents, task nodes) gets the
  middleware once, bound to the run, directly outside ``ToolErrorMiddleware``;
* the normalizer emits ``SOURCES`` right after the tool's result and usage, in
  the same namespace, and drops a malformed stamp;
* the citing section is in the prompt only when a tool hands out ids.
"""
from __future__ import annotations

import asyncio
import importlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import psycopg
import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool

FIXTURES = Path(__file__).parent / "fixtures" / "sources"
SEARCH = (FIXTURES / "tavily-search.txt").read_text(encoding="utf-8")


class _Store:
    """Records what the middleware keeps; can be told to fail or hang."""

    def __init__(self, fail: BaseException | None = None, hang: bool = False):
        self.kept: list[tuple[str, str, list[Any]]] = []
        self._fail = fail
        self._hang = hang

    async def upsert_many(self, user_id, conversation_id, sources):
        if self._hang:
            await asyncio.sleep(10)
        if self._fail is not None:
            raise self._fail
        self.kept.append((user_id, conversation_id, list(sources)))
        return len(sources)


@pytest.fixture
def mw(agents_service):
    return importlib.import_module("harness.middlewares.sources")


def _request(name: str = "tavily-search", call_id: str = "c1") -> SimpleNamespace:
    return SimpleNamespace(tool_call={"id": call_id, "name": name, "args": {}})


def _run(middleware, result: Any, name: str = "tavily-search") -> Any:
    async def handler(request):
        return result

    return asyncio.run(middleware.awrap_tool_call(_request(name), handler))


# ------------------------------------------------------------------ the middleware
def test_the_model_sees_the_ids_and_the_result_is_stamped_and_kept(mw):
    store = _Store()
    middleware = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store)

    result = _run(middleware, ToolMessage(content=SEARCH, tool_call_id="c1", name="tavily-search"))

    stamp = result.response_metadata[mw.SOURCES_KEY]
    assert len(stamp) == 3
    assert set(stamp[0]) == {"id", "url", "title", "snippet", "tool"}
    for source in stamp:
        assert f"[src:{source['id']}] Title: {source['title']}" in result.content
    [(user_id, conversation_id, kept)] = store.kept
    assert (user_id, conversation_id) == ("u1", "c1")
    assert [s.id for s in kept] == [s["id"] for s in stamp]


def test_a_tool_without_an_extractor_is_untouched(mw):
    store = _Store()
    message = ToolMessage(content="Title: X\nURL: https://a.example/\n", tool_call_id="c1", name="read_file")
    result = _run(mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store), message, name="read_file")
    assert result.content == "Title: X\nURL: https://a.example/\n"
    assert mw.SOURCES_KEY not in (result.response_metadata or {})
    assert store.kept == []


def test_an_error_result_and_a_command_are_left_alone(mw):
    store = _Store()
    middleware = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store)
    error = _run(middleware, ToolMessage(content=SEARCH, tool_call_id="c1", status="error"))
    assert error.content == SEARCH and mw.SOURCES_KEY not in (error.response_metadata or {})

    command_module = importlib.import_module("langgraph.types")
    command = command_module.Command(update={"messages": [ToolMessage(content=SEARCH, tool_call_id="c1")]})
    assert _run(middleware, command) is command
    assert store.kept == []


def test_a_bad_url_is_dropped_from_the_stamp(mw):
    content = "Title: Ok\nURL: https://ok.example/\nContent: a\n\nTitle: Bad\nURL: javascript:alert(1)\nContent: b\n"
    result = _run(mw.SourcesMiddleware(store=_Store()), ToolMessage(content=content, tool_call_id="c1"))
    assert [s["title"] for s in result.response_metadata[mw.SOURCES_KEY]] == ["Ok"]
    assert "] Title: Bad" not in result.content


def test_a_run_without_a_conversation_marks_but_keeps_nothing(mw):
    store = _Store()
    result = _run(mw.SourcesMiddleware(user_id="u1", store=store), ToolMessage(content=SEARCH, tool_call_id="c1"))
    assert result.response_metadata[mw.SOURCES_KEY] and store.kept == []


@pytest.mark.parametrize("store", [
    _Store(fail=psycopg.OperationalError("connection lost")),
    _Store(fail=RuntimeError("Agent memory pool is not initialized.")),
], ids=["database-down", "no-pool"])
def test_a_store_failure_never_fails_the_call(mw, store):
    result = _run(mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store),
                  ToolMessage(content=SEARCH, tool_call_id="c1"))
    assert "[src:" in result.content and result.response_metadata[mw.SOURCES_KEY]


def test_a_hanging_store_is_given_up(mw, monkeypatch):
    monkeypatch.setattr(mw, "STORE_TIMEOUT_SECONDS", 0.05)
    result = _run(mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=_Store(hang=True)),
                  ToolMessage(content=SEARCH, tool_call_id="c1"))
    assert result.response_metadata[mw.SOURCES_KEY]


def test_the_sync_path_marks_and_stamps(mw):
    store = _Store()
    result = mw.SourcesMiddleware(user_id="u1", conversation_id="c1", store=store).wrap_tool_call(
        _request(), lambda request: ToolMessage(content=SEARCH, tool_call_id="c1"),
    )
    assert "[src:" in result.content and len(result.response_metadata[mw.SOURCES_KEY]) == 3
    assert store.kept == []  # the store is async-only


def test_an_exception_from_the_tool_propagates_untouched(mw):
    errors = importlib.import_module("langgraph.errors")

    async def pausing(request):
        raise errors.GraphInterrupt(())

    with pytest.raises(errors.GraphInterrupt):
        asyncio.run(mw.SourcesMiddleware(store=_Store()).awrap_tool_call(_request(), pausing))


# ---------------------------------------------------------------------- wiring
@tool("tavily-search")
def _tavily_search(query: str) -> str:
    """Search the web."""
    return ""


@tool("read_file")
def _read_file(path: str) -> str:
    """Read a file."""
    return ""


@pytest.fixture
def deep(agents_service):
    return importlib.import_module("harness.abstractions.deep_agent")


def _agent(deep, context: dict[str, Any] | None = None):
    class _SourcesAgent(deep.DeepAgent):
        name = "sources-test-deep"

        def register_agent(self):
            return None

    base = {"user_id": "u1", "conversation_id": "c1", "run_id": "r1"}
    return _SourcesAgent(config={"context": {**base, **(context or {})}})


def _build(deep, monkeypatch, tools: list[Any]) -> dict[str, Any]:
    captured: dict[str, Any] = {}
    monkeypatch.setattr(deep, "create_deep_agent", lambda **kwargs: captured.update(kwargs))
    agent = _agent(deep)
    agent.tools = list(tools)
    monkeypatch.setattr(agent, "_build_composite_backend", lambda: None)
    monkeypatch.setattr(agent, "_uses_async_subagents", lambda subagents: False)
    monkeypatch.setattr(agent, "_builtin_tools", lambda: [])  # they need the databases
    agent.build_deep_agent(
        model="openai:gpt-5", middleware=[], interrupt_on={},
        subagents=[{"name": "researcher", "description": "d", "system_prompt": "p"}],
    )
    return captured


def test_every_stack_gets_one_sources_middleware_bound_to_the_run(deep, mw, monkeypatch):
    errors = importlib.import_module("harness.middlewares.tool_error")
    metrics = importlib.import_module("harness.middlewares.tool_metrics")
    captured = _build(deep, monkeypatch, [_tavily_search])

    stacks = [captured["middleware"], *(sub["middleware"] for sub in captured["subagents"])]
    assert len(stacks) == 3  # main, general-purpose, researcher
    for stack in stacks:
        [index] = [i for i, m in enumerate(stack) if isinstance(m, mw.SourcesMiddleware)]
        assert isinstance(stack[index + 1], errors.ToolErrorMiddleware)
        assert isinstance(stack[index - 1], metrics.ToolMetricsMiddleware)
        assert (stack[index].user_id, stack[index].conversation_id) == ("u1", "c1")


def test_the_run_middleware_is_idempotent_and_used_for_task_nodes(deep, mw):
    agent = _agent(deep, {"conversation_id": "c9"})
    once = agent._run_middleware([])
    assert agent._run_middleware(once) == once
    [sources] = [m for m in once if isinstance(m, mw.SourcesMiddleware)]
    assert sources.conversation_id == "c9"


def test_the_citing_section_follows_the_agent_s_tools(deep, monkeypatch):
    with_search = _build(deep, monkeypatch, [_tavily_search, _read_file])
    assert "## Cite What You Found" in with_search["system_prompt"]
    without = _build(deep, monkeypatch, [_read_file])
    assert "## Cite What You Found" not in without["system_prompt"]


def test_a_task_node_s_prompt_context_reads_its_own_tools(deep):
    agent = _agent(deep)
    agent.tools = [_tavily_search]
    assert agent.prompt_context().has_source_tools is True
    assert agent.prompt_context(tools=[_read_file]).has_source_tools is False


# ------------------------------------------------------------------- prompt text
@pytest.fixture
def pe(agents_service):
    return importlib.import_module("harness.prompt_engineering")


def test_the_section_is_present_only_with_a_source_tool(pe):
    on = pe.compose_system_prompt("x", pe.PromptContext(has_source_tools=True))
    off = pe.compose_system_prompt("x", pe.PromptContext())
    assert "## Cite What You Found" in on and "`[src:3fa2c1,9b02e4]`" in on
    assert off == "x"
    assert pe.describe_sections(pe.PromptContext(has_source_tools=True)) == ["citations"]


def test_the_section_sits_after_the_capabilities_and_tasks_get_it(pe):
    context = pe.PromptContext(has_source_tools=True, has_conversation=True, narrate_progress=True)
    names = pe.describe_sections(context)
    assert names.index("citations") == names.index("capabilities") + 1
    task = pe.PromptContext(has_source_tools=True, has_conversation=True, narrate_progress=True,
                            narrate_as_subagent=True)
    assert [name for name, _ in pe.task_sections(task)] == ["citations", "efficiency", "progress"]


def test_the_section_is_short_and_does_not_shout(pe):
    text = pe.compose_system_prompt("", pe.PromptContext(has_source_tools=True))
    assert len(text.split()) < 110
    assert "ALWAYS" not in text and "NEVER" not in text and "MUST" not in text


# -------------------------------------------------------------------- normalizer
def _frames(chunks: list[bytes]) -> list[dict]:
    return [json.loads(c.decode().split("data:", 1)[1].strip()) for c in chunks]


def _names(frames: list[dict]) -> list[str]:
    return [f["name"] if f.get("type") == "CUSTOM" else f["type"] for f in frames]


def _call(call_id: str) -> dict:
    return {"model": {"messages": [AIMessage(content="", tool_calls=[
        {"id": call_id, "name": "tavily-search", "args": {}},
    ])]}}


def _stamped_result(mw, call_id: str) -> dict:
    message = ToolMessage(content=SEARCH, tool_call_id=call_id, name="tavily-search")
    asyncio.run(mw.SourcesMiddleware(store=_Store()).awrap_tool_call(_request(call_id=call_id),
                                                                       _return(message)))
    metrics = importlib.import_module("harness.middlewares.tool_metrics")
    message.response_metadata[metrics.TOOL_METRICS_KEY] = {
        "tool_name": "tavily-search", "duration_ms": 5, "status": "ok", "output_chars": 10,
    }
    return {"tools": {"messages": [message]}}


def _return(message):
    async def handler(request):
        return message
    return handler


@pytest.fixture
def normalizer(agents_service):
    module = importlib.import_module("harness.agui.normalizer")
    return module.AGUIStreamNormalizer(thread_id=f"src-{uuid4()}")


def test_the_normalizer_emits_sources_after_the_result(mw, normalizer):
    normalizer.handle_chunk(_call("c1"))
    frames = _frames(normalizer.handle_chunk(_stamped_result(mw, "c1")))

    names = _names(frames)
    assert names.index("SOURCES") > names.index("TOOL_CALL_END") > names.index("TOOL_CALL_RESULT")
    assert names.index("SOURCES") > names.index("TOOL_USAGE")
    [event] = [f["value"] for f in frames if f.get("name") == "SOURCES"]
    assert event["tool_call_id"] == "c1" and len(event["sources"]) == 3
    assert set(event["sources"][0]) == {"id", "url", "title", "snippet", "tool"}
    # The pages travel as SOURCES; their contents never leave the agents service.
    [result] = [f for f in frames if f["type"] == "TOOL_CALL_RESULT"]
    assert result["content"] == "" and "[src:" not in json.dumps(result)


def test_a_sub_agent_s_sources_are_wrapped_like_its_other_events(mw, normalizer):
    namespace = ("tools:sub-1",)
    normalizer.handle_chunk((namespace, "updates", _call("c2")))
    frames = _frames(normalizer.handle_chunk((namespace, "updates", _stamped_result(mw, "c2"))))
    assert {f["name"] for f in frames} == {"SUBAGENT_EVENT"}
    [sources] = [f["value"]["event"] for f in frames if f["value"]["event"].get("name") == "SOURCES"]
    assert sources["value"]["tool_call_id"] == "c2" and frames[0]["value"]["task_id"] == "sub-1"


@pytest.mark.parametrize("stamp", [
    "not a list",
    [{"id": "abc123", "url": "javascript:alert(1)", "title": "t", "snippet": "", "tool": "x"}],
    [{"id": "NOTHEX", "url": "https://a.example/"}],
])
def test_a_malformed_stamp_is_dropped_not_streamed(mw, normalizer, stamp):
    normalizer.handle_chunk(_call("c3"))
    message = ToolMessage(content="r", tool_call_id="c3", name="tavily-search")
    message.response_metadata = {mw.SOURCES_KEY: stamp}
    frames = _frames(normalizer.handle_chunk({"tools": {"messages": [message]}}))
    assert "TOOL_CALL_RESULT" in _names(frames) and "SOURCES" not in _names(frames)
    # Without valid sources the card still gets the result text.
    [result] = [f for f in frames if f["type"] == "TOOL_CALL_RESULT"]
    assert result["content"] == "r"


def test_no_stamp_means_no_sources_event(normalizer):
    normalizer.handle_chunk(_call("c4"))
    bare = {"tools": {"messages": [ToolMessage(content="r", tool_call_id="c4", name="tavily-search")]}}
    assert "SOURCES" not in _names(_frames(normalizer.handle_chunk(bare)))
