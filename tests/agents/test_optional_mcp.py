"""MCP is optional: a run never fails because the MCP gateway is absent.

Pinned:

* no gateway URL configured → no session, no network call, an empty catalog;
* a gateway that refuses the connection, or accepts it but never finishes the
  handshake, → no session within the connect timeout, and the run goes ahead;
* once a session is up, anything the caller's own work raises propagates
  unchanged — it is never swallowed as if it were a gateway outage;
* the catalog fetch shares the connect deadline, and a failed fetch is not
  retried for a short while;
* with MCP off, the Agents tab never offers an MCP tool as available, a run
  does not warn that its MCP tools are "missing", and a run paused on an MCP
  tool's approval resumes into an error result the model can read.
"""
from __future__ import annotations

import asyncio
import importlib
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from core.settings import settings
from utils import mcp_tools
from utils.mcp_tools import list_mcp_tools, optional_mcp_session


@pytest.fixture
def mcp_url(monkeypatch):
    def configure(url: str, timeout: float = 0.2) -> None:
        monkeypatch.setattr(settings.mcp, "mcp_gateway_url", url)
        monkeypatch.setattr(settings.mcp, "connect_timeout_seconds", timeout)

    return configure


def _session_of(cm_factory) -> object:
    async def run():
        async with cm_factory() as session:
            return session

    return asyncio.run(run())


def test_no_gateway_configured_means_no_session_and_no_call(mcp_url, monkeypatch):
    mcp_url("")

    def must_not_connect(*_args, **_kwargs):
        raise AssertionError("must not contact a gateway when MCP is off")

    monkeypatch.setattr(mcp_tools, "sse_client", must_not_connect)
    assert settings.mcp.enabled is False
    assert _session_of(optional_mcp_session) is None
    assert asyncio.run(list_mcp_tools()) == []


def test_a_gateway_that_refuses_the_connection_gives_no_session(mcp_url, monkeypatch):
    mcp_url("http://mcp_gateway:8005/sse")

    @asynccontextmanager
    async def refused(**_kwargs):
        raise ConnectionError("Name or service not known")
        yield  # pragma: no cover

    monkeypatch.setattr(mcp_tools, "sse_client", refused)
    assert _session_of(optional_mcp_session) is None


def test_a_gateway_that_never_finishes_its_handshake_times_out(mcp_url, monkeypatch):
    mcp_url("http://mcp_gateway:8005/sse", timeout=0.1)

    @asynccontextmanager
    async def hangs(**_kwargs):
        await asyncio.sleep(3600)  # accepts the connection, never sends its endpoint
        yield None, None  # pragma: no cover

    monkeypatch.setattr(mcp_tools, "sse_client", hangs)

    async def run():
        started = asyncio.get_running_loop().time()
        async with optional_mcp_session() as session:
            return session, asyncio.get_running_loop().time() - started

    session, elapsed = asyncio.run(run())
    assert session is None
    assert elapsed < 2


class _FakeSession:
    def __init__(self, *_args):
        self.initialized = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def initialize(self):
        self.initialized = True


def _working_gateway(monkeypatch):
    @asynccontextmanager
    async def ok(**_kwargs):
        yield "read", "write"

    monkeypatch.setattr(mcp_tools, "sse_client", ok)
    monkeypatch.setattr(mcp_tools.mcp, "ClientSession", _FakeSession)


def test_a_reachable_gateway_yields_an_initialized_session(mcp_url, monkeypatch):
    mcp_url("http://mcp_gateway:8005/sse")
    _working_gateway(monkeypatch)
    session = _session_of(optional_mcp_session)
    assert isinstance(session, _FakeSession) and session.initialized


def test_the_callers_own_error_is_never_swallowed(mcp_url, monkeypatch):
    mcp_url("http://mcp_gateway:8005/sse", timeout=0.1)
    _working_gateway(monkeypatch)

    async def run():
        async with optional_mcp_session() as session:
            assert session is not None
            await asyncio.sleep(0.3)  # longer than the connect timeout: it must not fire
            raise ValueError("the agent run failed")

    with pytest.raises(ValueError, match="the agent run failed"):
        asyncio.run(run())


# ---------------------------------------------------------------------------
# Catalog fetch: the same connect deadline, and a failure remembered briefly
# ---------------------------------------------------------------------------
def _counting_hang(monkeypatch) -> list[str]:
    calls: list[str] = []

    @asynccontextmanager
    async def hangs(url, timeout):
        calls.append(url)
        await asyncio.sleep(3600)  # accepts the connection, never sends its endpoint
        yield None, None  # pragma: no cover

    monkeypatch.setattr(mcp_tools, "sse_client", hangs)
    return calls


def test_a_hung_gateway_fails_the_catalog_fetch_within_the_connect_timeout(mcp_url, monkeypatch):
    mcp_url("http://mcp_gateway:8005/sse", timeout=0.1)
    monkeypatch.setattr(mcp_tools, "_FETCH_FAILED_UNTIL", {})
    calls = _counting_hang(monkeypatch)

    async def run():
        started = asyncio.get_running_loop().time()
        with pytest.raises(mcp_tools.MCPToolsClientError, match="Failed to list tools"):
            await mcp_tools._fetch_tools_from_gateway()
        return asyncio.get_running_loop().time() - started

    assert asyncio.run(run()) < 2
    assert calls == ["http://mcp_gateway:8005/sse"]


def test_a_failed_fetch_is_not_retried_for_a_short_while(mcp_url, monkeypatch):
    # A cold cache and a down gateway must not make every Agents-page call wait
    # out the connect timeout again.
    endpoint = "http://mcp_gateway:8005/sse"
    mcp_url(endpoint, timeout=0.05)
    monkeypatch.setattr(mcp_tools, "_FETCH_FAILED_UNTIL", {})
    calls = _counting_hang(monkeypatch)

    for _ in range(3):
        with pytest.raises(mcp_tools.MCPToolsClientError):
            asyncio.run(mcp_tools._fetch_tools_from_gateway())
    assert calls == [endpoint]  # only the first one reached the gateway

    mcp_tools._FETCH_FAILED_UNTIL[endpoint] = 0.0  # the window has passed
    with pytest.raises(mcp_tools.MCPToolsClientError):
        asyncio.run(mcp_tools._fetch_tools_from_gateway())
    assert len(calls) == 2


def test_a_successful_fetch_clears_the_remembered_failure(mcp_url, monkeypatch):
    endpoint = "http://mcp_gateway:8005/sse"
    mcp_url(endpoint)
    monkeypatch.setattr(mcp_tools, "_FETCH_FAILED_UNTIL", {endpoint: 0.0})

    class _ListingSession(_FakeSession):
        async def list_tools(self):
            return SimpleNamespace(tools=["a-tool"])

    _working_gateway(monkeypatch)
    monkeypatch.setattr(mcp_tools.mcp, "ClientSession", _ListingSession)

    assert asyncio.run(mcp_tools._fetch_tools_from_gateway()) == ["a-tool"]
    assert endpoint not in mcp_tools._FETCH_FAILED_UNTIL


# ---------------------------------------------------------------------------
# Agents tab: with MCP off, MCP tools are never offered as available
# ---------------------------------------------------------------------------
@pytest.fixture
def agent_tools(agents_service):
    return importlib.import_module("utils.agent_tools")


def _declaring_agent(*refs: tuple[str, str]) -> SimpleNamespace:
    spec_module = importlib.import_module("harness.abstractions.agent_spec")
    tools = [spec_module.ToolRef(server_id=s, tool_name=t) for s, t in refs]
    return SimpleNamespace(spec=SimpleNamespace(tools=tools))


def _prime_catalog(agents_service, *keys: str) -> None:
    for key in keys:
        server_id, tool_name = key.split("/")
        agents_service.mcp_tools._MCP_TOOL_MANIFEST_CACHE[key] = agents_service.schemas.ToolManifest(
            server_id=server_id, tool_name=tool_name
        )


def test_mcp_rows_with_mcp_on_list_declared_and_catalog_tools(agents_service, agent_tools):
    _prime_catalog(agents_service, "tavily/tavily-search", "arxiv/search_papers")
    definition = _declaring_agent(("tavily", "tavily-search"))

    rows = {r.key: r for r in agent_tools._mcp_rows(definition, set())}

    assert set(rows) == {"tavily/tavily-search", "arxiv/search_papers"}
    assert all(r.available and r.unavailableReason is None for r in rows.values())
    assert rows["tavily/tavily-search"].declared and not rows["arxiv/search_papers"].declared


def test_mcp_rows_with_mcp_off_keep_declared_tools_unavailable_and_drop_the_catalog(
    agents_service, agent_tools, monkeypatch
):
    monkeypatch.setattr(agents_service.settings_module.settings.mcp, "mcp_gateway_url", "")
    _prime_catalog(agents_service, "tavily/tavily-search", "arxiv/search_papers")
    definition = _declaring_agent(("tavily", "tavily-search"))

    rows = agent_tools._mcp_rows(definition, set())

    assert [r.key for r in rows] == ["tavily/tavily-search"]
    assert rows[0].available is False
    assert rows[0].unavailableReason == agent_tools.MCP_DISABLED_REASON == "MCP is not enabled on this deployment"


async def test_agent_tools_route_does_not_touch_the_gateway_when_mcp_is_off(
    client, agents_service, internal_headers, monkeypatch
):
    monkeypatch.setattr(agents_service.settings_module.settings.mcp, "mcp_gateway_url", "")
    router = importlib.import_module("router.agent_tools")

    async def must_not_warm():
        raise AssertionError("no gateway call when MCP is off")

    async def no_rows(*_args, **_kwargs):
        return []

    monkeypatch.setattr(router, "list_mcp_tools", must_not_warm)
    monkeypatch.setattr(router, "list_agent_tools", no_rows)

    response = await client.get("/agents/u1/some-agent/tools", headers=internal_headers)

    assert response.status_code == 200
    assert response.json() == {"agentSlug": "some-agent", "tools": []}


# ---------------------------------------------------------------------------
# A run with MCP off: declared MCP tools are expected absent, not "missing"
# ---------------------------------------------------------------------------
class _RecordingLogger:
    def __init__(self):
        self.events: list[tuple[str, str]] = []

    def info(self, event, *_args, **_kwargs):
        self.events.append(("info", event))

    def warning(self, event, *_args, **_kwargs):
        self.events.append(("warning", event))


def _filter(agents_service, monkeypatch, *, declared, enabled=()):
    base_agent = agents_service.base_agent
    recorder = _RecordingLogger()
    monkeypatch.setattr(base_agent, "logger", recorder)
    agent = base_agent.BaseAgent.__new__(base_agent.BaseAgent)
    agent.name = "stub"
    agent.config_tool_names = list(declared)
    agent.tool_config = base_agent.ToolConfig(enabled=frozenset(enabled))
    return agent._filter_live_tools([]), recorder.events


def test_no_missing_tools_warning_when_mcp_is_off(agents_service, monkeypatch):
    monkeypatch.setattr(agents_service.settings_module.settings.mcp, "mcp_gateway_url", "")
    tools, events = _filter(
        agents_service, monkeypatch, declared=["tavily/tavily-search"], enabled=["arxiv/search_papers"]
    )
    assert tools == []
    assert events == [("info", "agent_tools_mcp_disabled")]


def test_a_gateway_that_lacks_declared_tools_still_warns(agents_service, monkeypatch):
    # MCP on: an absent declared tool is a real gap worth a warning.
    _tools, events = _filter(agents_service, monkeypatch, declared=["tavily/tavily-search"])
    assert ("warning", "agent_tools_missing") in events


# ---------------------------------------------------------------------------
# Resume: a run paused on an MCP tool's approval, resumed with no MCP
# ---------------------------------------------------------------------------
class _ToolCallingFake(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def test_approving_an_mcp_tool_after_mcp_went_away_returns_an_error_to_the_model(agents_service):
    """The approved call reaches a tool node that no longer has the tool (the
    resume attached no MCP tools): the model gets an error ToolMessage it can
    read and the run carries on — nothing crashes."""
    deep_agent = importlib.import_module("harness.abstractions.deep_agent").DeepAgent

    @tool
    def tavily_search(query: str) -> str:
        """Search the web."""
        return "results"

    @tool
    def write_todos(todos: str) -> str:
        """A builtin the agent always has."""
        return "ok"

    checkpointer = InMemorySaver()
    config = {"configurable": {"thread_id": "paused-on-mcp"}}

    def build(tools, replies):
        middleware = [
            HumanInTheLoopMiddleware(interrupt_on={"tavily_search": True}),
            *deep_agent._ensure_platform_middleware([]),
        ]
        model = _ToolCallingFake(messages=iter(replies))
        return create_agent(model=model, tools=tools, middleware=middleware, checkpointer=checkpointer)

    call = AIMessage(content="", tool_calls=[{"id": "call-1", "name": "tavily_search", "args": {"query": "x"}}])
    paused = build([tavily_search, write_todos], [call])

    async def run():
        first = await paused.ainvoke({"messages": [HumanMessage(content="search")]}, config)
        assert first.get("__interrupt__"), "the MCP tool call must pause for approval"
        # Resumed on a deployment (or at a moment) without MCP: builtins only.
        resumed = build([write_todos], [AIMessage(content="search is unavailable right now")])
        return await resumed.ainvoke(Command(resume={"decisions": [{"type": "approve"}]}), config)

    result = asyncio.run(run())
    tool_messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert len(tool_messages) == 1
    assert tool_messages[0].status == "error"
    assert "tavily_search" in tool_messages[0].content
    assert result["messages"][-1].content == "search is unavailable right now"
