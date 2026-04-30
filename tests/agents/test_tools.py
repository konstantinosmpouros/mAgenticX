from __future__ import annotations

from fastapi import HTTPException


async def test_tools_route_uses_cached_manifests(client, agents_service, internal_headers, monkeypatch):
    manifest = agents_service.schemas.ToolManifest(
        server_id="rag",
        tool_name="sql_query",
        description="Run a SQL query",
        parameter_count=1,
    )
    monkeypatch.setattr(agents_service.main, "get_cached_tool_manifests", lambda: [manifest])

    async def should_not_refresh():
        raise AssertionError("list_mcp_tools should not run when cache is warm")

    monkeypatch.setattr(agents_service.main, "list_mcp_tools", should_not_refresh)

    response = await client.get("/tools", headers=internal_headers)

    assert response.status_code == 200
    assert response.json() == [manifest.model_dump()]


async def test_tools_route_refreshes_cache_when_empty(client, agents_service, internal_headers, monkeypatch):
    manifest = agents_service.schemas.ToolManifest(
        server_id="rag",
        tool_name="schema_lookup",
        description="Load schema",
        parameter_count=0,
    )
    cache_state = {"items": []}

    monkeypatch.setattr(agents_service.main, "get_cached_tool_manifests", lambda: cache_state["items"])

    async def fake_refresh():
        cache_state["items"] = [manifest]
        return []

    monkeypatch.setattr(agents_service.main, "list_mcp_tools", fake_refresh)

    response = await client.get("/tools", headers=internal_headers)

    assert response.status_code == 200
    assert response.json() == [manifest.model_dump()]


async def test_tools_route_returns_502_when_gateway_fails(client, agents_service, internal_headers, monkeypatch):
    monkeypatch.setattr(agents_service.main, "get_cached_tool_manifests", lambda: [])

    async def fake_refresh():
        raise agents_service.main.MCPToolsClientError("gateway unavailable")

    monkeypatch.setattr(agents_service.main, "list_mcp_tools", fake_refresh)

    response = await client.get("/tools", headers=internal_headers)

    assert response.status_code == 502
    assert response.json()["detail"] == "Tool catalog is temporarily unavailable."
