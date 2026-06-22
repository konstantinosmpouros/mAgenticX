from __future__ import annotations

from types import SimpleNamespace


class _FakeTranscriptionAPI:
    def create(self, model, file):
        return SimpleNamespace(text="meeting transcript")


class _FakeOpenAIClient:
    def __init__(self):
        self.audio = SimpleNamespace(transcriptions=_FakeTranscriptionAPI())


class _FakeSessionContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeAgent:
    def __init__(self, config=None):
        self.config = config
        self.tools_names = []

    def attach_tools(self, tools):
        self.tools_names = [tool.get("name", "") for tool in tools]

    async def astream(self, payload):
        yield b"data: start\n\n"
        yield b"data: done\n\n"

    def _encode_run_error(self, exc):
        return f"data: error {exc}\n\n".encode("utf-8")


class _FailingStreamAgent(_FakeAgent):
    async def astream(self, payload):
        raise RuntimeError("stream broke")
        yield b""


class _FailingInitAgent(_FakeAgent):
    def __init__(self, config=None):
        raise RuntimeError("bad config")


async def test_agents_manifest_route_returns_sorted_manifests(client, agents_service, internal_headers, monkeypatch):
    registry = {
        "z-agent": SimpleNamespace(manifest={"id": "2", "slug": "z-agent", "name": "Z Agent", "type": "langgraph", "description": "Zed", "icon": "z"}),
        "a-agent": SimpleNamespace(manifest={"id": "1", "slug": "a-agent", "name": "A Agent", "type": "langgraph", "description": "Alpha", "icon": "a"}),
    }
    monkeypatch.setattr(agents_service.router_catalog, "AGENT_REGISTRY", registry)

    response = await client.get("/agents", headers=internal_headers)

    assert response.status_code == 200
    assert [item["name"] for item in response.json()] == ["A Agent", "Z Agent"]


async def test_dictation_route_transcribes_audio(client, agents_service, internal_headers, monkeypatch):
    monkeypatch.setattr(agents_service.router_voice, "get_openai_client", lambda: _FakeOpenAIClient())

    response = await client.post(
        "/dictate/transcribe",
        headers=internal_headers,
        files={"file": ("memo.wav", b"wave-data", "audio/wav")},
    )

    assert response.status_code == 200
    assert response.json() == {"text": "meeting transcript"}


async def test_dictation_route_rejects_empty_audio(client, internal_headers):
    response = await client.post(
        "/dictate/transcribe",
        headers=internal_headers,
        files={"file": ("empty.wav", b"", "audio/wav")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "The uploaded audio file is empty."


async def test_stream_route_rejects_unknown_agent(client, agents_service, internal_headers):
    response = await client.post(
        "/agents/missing-agent/stream",
        headers=internal_headers,
        json={"messages": [{"role": "user", "content": "Hello"}], "config": {}},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown agent."


async def test_stream_route_forwards_chunks_from_agent_runtime(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    registry = {
        "demo-agent": SimpleNamespace(
            cls=_FakeAgent,
            manifest={"id": "1", "slug": "demo-agent", "name": "Demo Agent", "type": "langgraph", "description": "Demo", "icon": "bot"},
        )
    }
    monkeypatch.setattr(agents_service.router_inference, "AGENT_REGISTRY", registry)
    monkeypatch.setattr(agents_service.router_inference, "mcp_session_context", lambda: _FakeSessionContext())
    async def fake_load_mcp_tools(session):
        return [{"name": "sql_query"}]

    monkeypatch.setattr(agents_service.router_inference, "load_mcp_tools", fake_load_mcp_tools)

    response = await client.post(
        "/agents/demo-agent/stream",
        headers=internal_headers,
        json={
            "messages": [{"role": "user", "content": "Hello"}],
            "config": {"context": {"user_id": "u1", "conversation_id": "c1"}},
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text == "data: start\n\ndata: done\n\n"


async def test_stream_route_returns_400_when_agent_initialization_fails(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    registry = {
        "bad-agent": SimpleNamespace(
            cls=_FailingInitAgent,
            manifest={"id": "1", "slug": "bad-agent", "name": "Bad Agent", "type": "langgraph", "description": "Bad", "icon": "bot"},
        )
    }
    monkeypatch.setattr(agents_service.router_inference, "AGENT_REGISTRY", registry)

    response = await client.post(
        "/agents/bad-agent/stream",
        headers=internal_headers,
        json={"messages": [{"role": "user", "content": "Hello"}], "config": {}},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Failed to initialise the requested agent."


async def test_stream_route_encodes_runtime_errors(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    registry = {
        "demo-agent": SimpleNamespace(
            cls=_FailingStreamAgent,
            manifest={"id": "1", "slug": "demo-agent", "name": "Demo Agent", "type": "langgraph", "description": "Demo", "icon": "bot"},
        )
    }
    monkeypatch.setattr(agents_service.router_inference, "AGENT_REGISTRY", registry)
    monkeypatch.setattr(agents_service.router_inference, "mcp_session_context", lambda: _FakeSessionContext())

    async def fake_load_mcp_tools(session):
        return []

    monkeypatch.setattr(agents_service.router_inference, "load_mcp_tools", fake_load_mcp_tools)

    response = await client.post(
        "/agents/demo-agent/stream",
        headers=internal_headers,
        json={"messages": [{"role": "user", "content": "Hello"}], "config": {}},
    )

    assert response.status_code == 200
    assert response.text == "data: error stream broke\n\n"


async def test_routes_require_internal_caller(client):
    response = await client.get("/agents")

    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden"
