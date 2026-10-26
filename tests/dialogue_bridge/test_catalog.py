from __future__ import annotations

import httpx
import pytest

from core.auth.session import require_current_user
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
            "kind": "platform",
            "model": None,
            "toolCount": None,
            "skillCount": None,
            "subagentCount": None,
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


# ---------------------------------------------------------------------------
# Builder catalogs: the model allowlist and the built-in tools (plan 44)
# ---------------------------------------------------------------------------
MODELS = [
    {"id": "openai:gpt-5", "label": "GPT-5", "default": True},
    {"id": "openai:gpt-5-mini", "label": "GPT-5 mini", "default": False},
]
BUILTINS = [
    {"name": "write_file", "description": "Write a file", "group": "Filesystem",
     "hitlDefault": True, "locked": False, "gateable": True, "mainOnly": False},
    {"name": "execute", "description": "Run a command", "group": "Execution",
     "hitlDefault": True, "locked": True, "gateable": True, "mainOnly": True},
]


@pytest.fixture
def signed_in(app, seeded_user):
    async def override_current_user():
        return seeded_user

    app.dependency_overrides[require_current_user] = override_current_user


@pytest.mark.parametrize(("route", "upstream", "payload"), [
    ("/v1/catalog/models", "/models", MODELS),
    ("/v1/catalog/builtin-tools", "/builtin-tools", BUILTINS),
])
async def test_builder_catalogs_proxy_the_agents_service_in_order(
    client, signed_in, agents_service, route, upstream, payload
):
    agents_service.on("GET", upstream, httpx.Response(200, json=payload))

    response = await client.get(route)

    assert response.status_code == 200
    assert response.json() == payload


@pytest.mark.parametrize("route", ["/v1/catalog/models", "/v1/catalog/builtin-tools"])
async def test_builder_catalogs_require_a_session(client, route):
    response = await client.get(route)
    assert response.status_code == 401


@pytest.mark.parametrize(("route", "upstream"), [
    ("/v1/catalog/models", "/models"),
    ("/v1/catalog/builtin-tools", "/builtin-tools"),
])
async def test_builder_catalogs_are_a_clean_404_until_upstream_serves_them(
    client, signed_in, agents_service, route, upstream
):
    """The bridge can ship first: the UI falls back to its own list on a 404."""
    agents_service.on("GET", upstream, httpx.Response(404, json={"detail": "Not Found"}))
    response = await client.get(route)
    assert response.status_code == 404


@pytest.mark.parametrize(("reply", "status_code"), [
    (httpx.Response(500, json={"detail": "boom"}), 502),
    (httpx.Response(200, json={"not": "a list"}), 502),
    (httpx.Response(200, content=b"not json"), 502),
])
async def test_builder_catalog_upstream_failures_use_the_house_errors(
    client, signed_in, agents_service, reply, status_code
):
    agents_service.on("GET", "/models", reply)
    response = await client.get("/v1/catalog/models")
    assert response.status_code == status_code
    assert "boom" not in response.text
