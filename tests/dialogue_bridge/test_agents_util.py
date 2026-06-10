"""Unit tests for utils.agents.

Covers the in-memory agent cache (prime/get + active filtering), the
slug-based URL builders (success + missing-slug 500 + missing-agent 404), and
``sync_agents_with_service`` exercised against the real SQLite session with the
agents-service HTTP layer faked out — upsert, deactivation of agents absent
from the manifest, and the unreachable/HTTP/invalid-payload error branches.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select

import utils.agents as agents_util
from core.database import AgentTable
from utils.agents import (
    build_agent_resume_url,
    build_agent_stream_url,
    fetch_tools_from_agents_service,
    get_agent_by_id,
    get_cached_agents,
    prime_agent_cache,
    sync_agents_with_service,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    prime_agent_cache([])
    yield
    prime_agent_cache([])


# ---------------------------------------------------------------------------
# agent cache
# ---------------------------------------------------------------------------

def test_prime_and_get_cached_agents_keeps_only_active():
    active = SimpleNamespace(id="a1", slug="alpha", is_active=True)
    inactive = SimpleNamespace(id="a2", slug="beta", is_active=False)
    prime_agent_cache([active, inactive])
    cached = get_cached_agents()
    assert [a.id for a in cached] == ["a1"]


def test_get_cached_agents_empty_when_not_primed():
    prime_agent_cache([])
    assert get_cached_agents() == []


def test_get_cached_agents_returns_copy_not_internal_dict():
    prime_agent_cache([SimpleNamespace(id="a1", slug="x", is_active=True)])
    first = get_cached_agents()
    first.clear()
    # Mutating the returned list must not empty the underlying cache.
    assert len(get_cached_agents()) == 1


# ---------------------------------------------------------------------------
# URL builders
# ---------------------------------------------------------------------------

def test_build_stream_url_uses_slug():
    agent = SimpleNamespace(id="a1", slug="researcher")
    url = build_agent_stream_url(agent)
    assert url.endswith("/agents/researcher/stream")


def test_build_resume_url_uses_slug():
    agent = SimpleNamespace(id="a1", slug="researcher")
    url = build_agent_resume_url(agent)
    assert url.endswith("/agents/researcher/resume")


def test_build_stream_url_none_agent_raises_404():
    with _expect_http(404):
        build_agent_stream_url(None)


def test_build_resume_url_none_agent_raises_404():
    with _expect_http(404):
        build_agent_resume_url(None)


def test_build_stream_url_missing_slug_raises_500():
    with _expect_http(500):
        build_agent_stream_url(SimpleNamespace(id="a1", slug=None))


def test_build_resume_url_missing_slug_raises_500():
    with _expect_http(500):
        build_agent_resume_url(SimpleNamespace(id="a1", slug=""))


# ---------------------------------------------------------------------------
# fake httpx plumbing for sync_agents_with_service
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, *, json_data=None, json_exc: Exception | None = None, http_error: httpx.HTTPStatusError | None = None):
        self._json_data = json_data
        self._json_exc = json_exc
        self._http_error = http_error

    def raise_for_status(self):
        if self._http_error is not None:
            raise self._http_error

    def json(self):
        if self._json_exc is not None:
            raise self._json_exc
        return self._json_data


class _FakeAsyncClient:
    def __init__(self, response=None, request_error: httpx.RequestError | None = None, **_kwargs):
        self._response = response
        self._request_error = request_error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def get(self, *_args, **_kwargs):
        if self._request_error is not None:
            raise self._request_error
        return self._response


def _patch_client(monkeypatch, *, response=None, request_error=None):
    def factory(*args, **kwargs):
        return _FakeAsyncClient(response=response, request_error=request_error)

    monkeypatch.setattr(agents_util.httpx, "AsyncClient", factory)


# ---------------------------------------------------------------------------
# sync_agents_with_service — happy paths
# ---------------------------------------------------------------------------

async def test_sync_upserts_manifests_and_primes_cache(session_factory, monkeypatch):
    manifests = [
        {
            "id": "agent-1",
            "slug": "alpha",
            "name": "Alpha",
            "description": "first",
            "icon": "bot",
            "version": "1.0",
            "type": "deep agent",
        },
        {
            "id": "agent-2",
            "name": "Beta",  # no slug → falls back to name
        },
    ]
    _patch_client(monkeypatch, response=_FakeResponse(json_data=manifests))

    async with session_factory() as session:
        refreshed = await sync_agents_with_service(session)

    ids = sorted(a.id for a in refreshed)
    assert ids == ["agent-1", "agent-2"]
    by_id = {a.id: a for a in refreshed}
    assert by_id["agent-1"].slug == "alpha"
    assert by_id["agent-1"].type == "deep agent"
    # slug falls back to name when manifest omits slug
    assert by_id["agent-2"].slug == "Beta"
    # default type applied when manifest omits it
    assert by_id["agent-2"].type == "langgraph agent"
    # cache is primed from the refreshed list
    assert sorted(a.id for a in get_cached_agents()) == ["agent-1", "agent-2"]


async def test_sync_deactivates_agents_absent_from_manifest(session_factory, monkeypatch):
    async with session_factory() as session:
        session.add(AgentTable(id="stale", slug="stale", name="Stale", description="", icon="", is_active=True))
        await session.commit()

    _patch_client(
        monkeypatch,
        response=_FakeResponse(json_data=[{"id": "fresh", "slug": "fresh", "name": "Fresh"}]),
    )
    async with session_factory() as session:
        refreshed = await sync_agents_with_service(session)

    assert [a.id for a in refreshed] == ["fresh"]
    async with session_factory() as session:
        stale = (await session.execute(select(AgentTable).where(AgentTable.id == "stale"))).scalar_one()
        assert stale.is_active is False


async def test_sync_skips_manifest_missing_id(session_factory, monkeypatch):
    _patch_client(
        monkeypatch,
        response=_FakeResponse(json_data=[{"slug": "no-id", "name": "No id"}, {"id": "ok", "slug": "ok", "name": "Ok"}]),
    )
    async with session_factory() as session:
        refreshed = await sync_agents_with_service(session)
    assert [a.id for a in refreshed] == ["ok"]


async def test_sync_empty_manifest_deactivates_everything(session_factory, monkeypatch):
    async with session_factory() as session:
        session.add(AgentTable(id="x", slug="x", name="X", description="", icon="", is_active=True))
        await session.commit()

    _patch_client(monkeypatch, response=_FakeResponse(json_data=[]))
    async with session_factory() as session:
        refreshed = await sync_agents_with_service(session)
    assert refreshed == []
    async with session_factory() as session:
        x = (await session.execute(select(AgentTable).where(AgentTable.id == "x"))).scalar_one()
        assert x.is_active is False


# ---------------------------------------------------------------------------
# sync_agents_with_service — error branches
# ---------------------------------------------------------------------------

async def test_sync_unreachable_raises_503(session_factory, monkeypatch):
    _patch_client(
        monkeypatch,
        request_error=httpx.ConnectError("connection refused", request=httpx.Request("GET", "http://agents.test/agents")),
    )
    async with session_factory() as session:
        with _expect_http(503):
            await sync_agents_with_service(session)


async def test_sync_http_status_error_raises_502(session_factory, monkeypatch):
    request = httpx.Request("GET", "http://agents.test/agents")
    response = httpx.Response(500, request=request)
    http_error = httpx.HTTPStatusError("boom", request=request, response=response)
    _patch_client(monkeypatch, response=_FakeResponse(http_error=http_error))
    async with session_factory() as session:
        with _expect_http(502):
            await sync_agents_with_service(session)


async def test_sync_invalid_json_raises(session_factory, monkeypatch):
    _patch_client(monkeypatch, response=_FakeResponse(json_exc=ValueError("not json")))
    async with session_factory() as session:
        with _expect_http():
            await sync_agents_with_service(session)


async def test_sync_non_list_payload_raises(session_factory, monkeypatch):
    _patch_client(monkeypatch, response=_FakeResponse(json_data={"agents": []}))
    async with session_factory() as session:
        with _expect_http():
            await sync_agents_with_service(session)


# ---------------------------------------------------------------------------
# get_agent_by_id
# ---------------------------------------------------------------------------

async def test_get_agent_by_id_returns_active_cached_agent():
    prime_agent_cache([SimpleNamespace(id="a1", slug="alpha", is_active=True)])
    agent = await get_agent_by_id("a1")
    assert agent is not None
    assert agent.id == "a1"


async def test_get_agent_by_id_unknown_returns_none():
    prime_agent_cache([SimpleNamespace(id="a1", slug="alpha", is_active=True)])
    assert await get_agent_by_id("missing") is None


# ---------------------------------------------------------------------------
# fetch_tools_from_agents_service
# ---------------------------------------------------------------------------

async def test_fetch_tools_returns_manifest_list(monkeypatch):
    tools = [{"server_id": "rag", "tool_name": "sql_query", "description": "", "parameter_count": 1}]
    _patch_client(monkeypatch, response=_FakeResponse(json_data=tools))
    assert await fetch_tools_from_agents_service() == tools


async def test_fetch_tools_unreachable_raises_503(monkeypatch):
    _patch_client(
        monkeypatch,
        request_error=httpx.ConnectError("down", request=httpx.Request("GET", "http://agents.test/tools")),
    )
    with _expect_http(503):
        await fetch_tools_from_agents_service()


async def test_fetch_tools_http_error_raises_502(monkeypatch):
    request = httpx.Request("GET", "http://agents.test/tools")
    http_error = httpx.HTTPStatusError("boom", request=request, response=httpx.Response(500, request=request))
    _patch_client(monkeypatch, response=_FakeResponse(http_error=http_error))
    with _expect_http(502):
        await fetch_tools_from_agents_service()


async def test_fetch_tools_invalid_json_raises(monkeypatch):
    _patch_client(monkeypatch, response=_FakeResponse(json_exc=ValueError("nope")))
    with _expect_http():
        await fetch_tools_from_agents_service()


async def test_fetch_tools_non_list_payload_raises(monkeypatch):
    _patch_client(monkeypatch, response=_FakeResponse(json_data={"tools": []}))
    with _expect_http():
        await fetch_tools_from_agents_service()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

from contextlib import contextmanager

from fastapi import HTTPException


@contextmanager
def _expect_http(expected_status: int | None = None):
    try:
        yield
    except HTTPException as exc:
        if expected_status is not None:
            assert exc.status_code == expected_status, f"expected {expected_status}, got {exc.status_code}"
        return
    raise AssertionError("HTTPException was not raised")
