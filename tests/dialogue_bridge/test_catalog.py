from __future__ import annotations

from core.auth_session import require_current_user
from router import catalog as catalog_router


async def test_get_available_agents_uses_cache_when_populated(app, client, seeded_user, seeded_agent, monkeypatch):
    async def override_current_user():
        return seeded_user

    app.dependency_overrides[require_current_user] = override_current_user
    monkeypatch.setattr(catalog_router, "get_cached_agents", lambda: [seeded_agent])

    async def should_not_sync(_db):
        raise AssertionError("sync_agents_with_service should not be called on a cache hit")

    monkeypatch.setattr(catalog_router, "sync_agents_with_service", should_not_sync)

    response = await client.get("/v1/catalog/agents")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": seeded_agent.id,
            "name": seeded_agent.name,
            "description": seeded_agent.description,
            "icon": seeded_agent.icon,
            "version": seeded_agent.version,
            "type": seeded_agent.type,
            "isActive": True,
        }
    ]


async def test_get_available_agents_syncs_when_cache_is_empty(app, client, seeded_user, seeded_agent, monkeypatch):
    async def override_current_user():
        return seeded_user

    app.dependency_overrides[require_current_user] = override_current_user
    monkeypatch.setattr(catalog_router, "get_cached_agents", lambda: [])

    async def fake_sync(_db):
        return [seeded_agent]

    monkeypatch.setattr(catalog_router, "sync_agents_with_service", fake_sync)

    response = await client.get("/v1/catalog/agents")

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [seeded_agent.id]


async def test_get_available_tools_proxies_tool_manifests(app, client, seeded_user, monkeypatch):
    async def override_current_user():
        return seeded_user

    app.dependency_overrides[require_current_user] = override_current_user
    async def fake_fetch_tools():
        return [
            {
                "server_id": "rag",
                "tool_name": "sql_query",
                "description": "Run a SQL query",
                "parameter_count": 1,
            }
        ]

    monkeypatch.setattr(catalog_router, "fetch_tools_from_agents_service", fake_fetch_tools)

    response = await client.get("/v1/catalog/tools")

    assert response.status_code == 200
    assert response.json() == [
        {
            "server_id": "rag",
            "tool_name": "sql_query",
            "description": "Run a SQL query",
            "parameter_count": 1,
        }
    ]
