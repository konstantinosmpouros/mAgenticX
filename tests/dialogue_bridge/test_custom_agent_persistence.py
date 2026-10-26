"""What the bridge still owns about a custom agent: its catalog row.

A custom agent is deliberately split. Its **identity** — the row in ``agents``
carrying ``owner_user_id``, the id the UI keys off, the target of every
conversation's foreign key — lives here, because the bridge reads it on every
page load and that must not become a cross-service hop. Its **definition** —
spec, ``AGENT.md``, sub-agent prompts, reference files — lives in
``agent_runtime``, because the agents service reads it on every run.

These pin the half that stayed, and the seam itself: the list is a pure query,
the detail is a join across the two.

The definition used to be mirrored here as ``agents.definition_spec`` plus
``agent_definition_files``, kept in step with a folder on the agents volume by a
900-second reconciliation pass. Both the copy and the pass are gone, and the
tests for them went with them.
"""

import inspect
import json

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from core.database import AgentTable
from utils import user_agents as ua

# The real helper's signature. Fakes bind their call against it, so a caller
# passing a keyword the helper does not take — or omitting a required one —
# fails here instead of only in production. A bare `**kwargs` fake is what let
# `_proxy(..., user_id=...)` ship and break Edit/Duplicate for ten days.
_PROXY_SIGNATURE = inspect.signature(ua._proxy)


@pytest.fixture
def owned_agent_factory(session_factory, seeded_user):
    async def _make(slug: str = "research-bot") -> str:
        async with session_factory() as session:
            row = AgentTable(
                owner_user_id=seeded_user.id,
                slug=slug,
                name="Research Bot",
                description="",
                icon="Bot",
                type="deep agent",
                is_active=True,
            )
            session.add(row)
            await session.commit()
            return row.id

    return _make


# ---------------------------------------------------------------------------
# The list stays local
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_listing_agents_never_calls_upstream(
    session_factory, seeded_user, owned_agent_factory, monkeypatch
):
    """The whole reason the catalog row did not move.

    This runs on every page load; making it a cross-service hop would mean a
    slow or restarting agents service made a user's own agents disappear from
    their settings.
    """

    async def _explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("listing agents must not call upstream")

    monkeypatch.setattr(ua, "_proxy", _explode)
    await owned_agent_factory("research-bot")
    await owned_agent_factory("second-bot")

    async with session_factory() as session:
        items = await ua.list_custom_agent_definitions(session, seeded_user.id)

    assert sorted(i["slug"] for i in items) == ["research-bot", "second-bot"]
    assert all("id" in i and "type" in i for i in items)


@pytest.mark.asyncio
async def test_list_excludes_a_deactivated_agent(
    session_factory, seeded_user, owned_agent_factory
):
    # Delete is a soft delete — the row survives so conversations keep their FK.
    # It must not come back in the list.
    agent_id = await owned_agent_factory()
    async with session_factory() as session:
        row = await session.get(AgentTable, agent_id)
        row.is_active = False
        await session.commit()

    async with session_factory() as session:
        assert await ua.list_custom_agent_definitions(session, seeded_user.id) == []


@pytest.mark.asyncio
async def test_another_users_agent_is_not_listed(
    session_factory, seeded_user, owned_agent_factory
):
    await owned_agent_factory()
    async with session_factory() as session:
        items = await ua.list_custom_agent_definitions(session, "some-other-user")
    assert items == []


# ---------------------------------------------------------------------------
# The detail is a join across the seam
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_detail_joins_the_local_row_with_the_upstream_definition(
    session_factory, seeded_user, owned_agent_factory, monkeypatch
):
    """The row resolves the id to a slug and proves ownership; the definition
    comes from the service that owns it. The builder still receives one object."""
    calls = []

    async def _fake_proxy(method, url, **kwargs):
        _PROXY_SIGNATURE.bind(method, url, **kwargs)  # TypeError on a bad call
        calls.append((method, url))
        return {
            "spec": {"slug": "research-bot", "prompt": "./AGENT.md"},
            "files": [{"path": "AGENT.md", "content": "You are Research Bot."}],
        }

    monkeypatch.setattr(ua, "_proxy", _fake_proxy)
    agent_id = await owned_agent_factory()

    async with session_factory() as session:
        detail = await ua.get_custom_agent_definition(session, seeded_user.id, agent_id)

    assert detail["slug"] == "research-bot"          # from the local row
    assert detail["spec"]["prompt"] == "./AGENT.md"  # from upstream
    assert [f["path"] for f in detail["files"]] == ["AGENT.md"]
    assert calls and calls[0][0] == "GET"
    # Addressed by slug, not by the catalog id: the agents service has never
    # heard of chat_db's ids.
    assert calls[0][1].endswith("/research-bot")


@pytest.mark.asyncio
async def test_another_users_agent_cannot_be_opened(
    session_factory, seeded_user, owned_agent_factory, monkeypatch
):
    """Ownership is checked against the local row *before* anything is fetched,
    so a wrong owner never reaches the definition at all."""

    async def _explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("ownership must be refused before fetching")

    monkeypatch.setattr(ua, "_proxy", _explode)
    agent_id = await owned_agent_factory()

    with pytest.raises(Exception) as exc:
        async with session_factory() as session:
            await ua.get_custom_agent_definition(session, "some-other-user", agent_id)
    assert getattr(exc.value, "status_code", None) in (403, 404)


# ---------------------------------------------------------------------------
# Create / update / delete / validate, through the routes
# ---------------------------------------------------------------------------
# The agents service is played by ``agents_service`` (a MockTransport), so the
# real proxy, error forwarding and catalog-row writes all run.
def _custom_path(user_id: str, suffix: str = "") -> str:
    return f"/users/{user_id}/custom-agents{suffix}"


def _summary(slug: str = "research-bot", **extra) -> dict:
    return {
        "slug": slug,
        "name": "Research Bot",
        "description": "Finds papers",
        "icon": "Search",
        "version": "1",
        "model": "openai:gpt-5",
        "tool_count": 3,
        "skill_count": 1,
        "subagent_count": 2,
        **extra,
    }


_WRITE_BODY = {
    "spec": {"slug": "research-bot", "name": "Research Bot", "prompt": "./AGENT.md"},
    "files": [{"path": "AGENT.md", "content": "You are Research Bot.", "encoding": "utf-8", "size": None}],
}


async def _row(session_factory, agent_id: str) -> AgentTable:
    async with session_factory() as session:
        return await session.get(AgentTable, agent_id)


@pytest.mark.asyncio
async def test_create_writes_upstream_first_then_the_catalog_row(
    client, agents_service, seeded_user, session_factory
):
    agents_service.on("POST", _custom_path(seeded_user.id), httpx.Response(201, json=_summary()))

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom", json=_WRITE_BODY)

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Research Bot"
    assert body["kind"] == "custom"
    # The create response carries the summary's counts too.
    assert (body["model"], body["toolCount"], body["skillCount"], body["subagentCount"]) == (
        "openai:gpt-5", 3, 1, 2,
    )
    sent = agents_service.called("POST", _custom_path(seeded_user.id))[0]
    assert json.loads(sent.content) == _WRITE_BODY
    row = await _row(session_factory, body["id"])
    assert row.owner_user_id == seeded_user.id and row.slug == "research-bot" and row.is_active


@pytest.mark.asyncio
async def test_update_replaces_upstream_and_refreshes_the_row(
    client, agents_service, seeded_user, owned_agent_factory, session_factory
):
    agent_id = await owned_agent_factory()
    agents_service.on(
        "PUT", _custom_path(seeded_user.id, "/research-bot"),
        httpx.Response(200, json=_summary(name="Renamed Bot", tool_count=5)),
    )

    response = await client.put(f"/v1/agents/{seeded_user.id}/custom/{agent_id}", json=_WRITE_BODY)

    assert response.status_code == 200
    assert response.json()["id"] == agent_id
    assert response.json()["toolCount"] == 5
    assert (await _row(session_factory, agent_id)).name == "Renamed Bot"


@pytest.mark.asyncio
async def test_delete_removes_upstream_and_only_deactivates_the_row(
    client, agents_service, seeded_user, owned_agent_factory, session_factory
):
    agent_id = await owned_agent_factory()
    agents_service.on("DELETE", _custom_path(seeded_user.id, "/research-bot"), httpx.Response(204))

    response = await client.delete(f"/v1/agents/{seeded_user.id}/custom/{agent_id}")

    assert response.status_code == 204
    row = await _row(session_factory, agent_id)
    assert row is not None and row.is_active is False  # conversations keep their FK


@pytest.mark.asyncio
async def test_update_and_delete_refuse_another_users_agent_before_upstream(
    client, agents_service, session_factory, owned_agent_factory
):
    agent_id = await owned_agent_factory()

    put = await client.put(f"/v1/agents/someone-else/custom/{agent_id}", json=_WRITE_BODY)
    delete = await client.delete(f"/v1/agents/someone-else/custom/{agent_id}")

    assert put.status_code == 404 and delete.status_code == 404
    assert agents_service.calls == []


@pytest.mark.asyncio
async def test_validate_passes_issues_through(client, agents_service, seeded_user):
    report = {
        "valid": False,
        "errors": ["subagents.0.name: must not be empty"],
        "issues": [
            {"path": "subagents.0.name", "message": "must not be empty", "severity": "error"},
            {"path": "description", "message": "is very short", "severity": "warning"},
        ],
    }
    agents_service.on("POST", _custom_path(seeded_user.id, "/validate"), httpx.Response(200, json=report))

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom/validate", json=_WRITE_BODY)

    assert response.status_code == 200
    assert response.json() == report


@pytest.mark.asyncio
async def test_validate_without_issues_from_an_older_agents_service(client, agents_service, seeded_user):
    agents_service.on(
        "POST", _custom_path(seeded_user.id, "/validate"),
        httpx.Response(200, json={"valid": True, "errors": []}),
    )
    response = await client.post(f"/v1/agents/{seeded_user.id}/custom/validate", json=_WRITE_BODY)
    assert response.json() == {"valid": True, "errors": [], "issues": []}


@pytest.mark.asyncio
async def test_an_invalid_definition_forwards_the_object_detail(
    client, agents_service, seeded_user, session_factory
):
    """The builder maps each issue to its field, so the 422's object detail must
    arrive whole, not flattened into a generic message."""
    detail = {
        "message": "The agent definition is invalid.",
        "errors": ["model: not allowed"],
        "issues": [{"path": "model", "message": "not allowed", "severity": "error"}],
    }
    agents_service.on("POST", _custom_path(seeded_user.id), httpx.Response(422, json={"detail": detail}))

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom", json=_WRITE_BODY)

    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    async with session_factory() as session:
        assert await ua.list_custom_agent_definitions(session, seeded_user.id) == []


@pytest.mark.asyncio
async def test_an_invalid_update_forwards_the_object_detail(
    client, agents_service, seeded_user, owned_agent_factory
):
    agent_id = await owned_agent_factory()
    detail = {"message": "invalid", "errors": ["x"], "issues": [{"path": "x", "message": "x", "severity": "error"}]}
    agents_service.on(
        "PUT", _custom_path(seeded_user.id, "/research-bot"), httpx.Response(422, json={"detail": detail})
    )

    response = await client.put(f"/v1/agents/{seeded_user.id}/custom/{agent_id}", json=_WRITE_BODY)

    assert response.status_code == 422
    assert response.json() == {"detail": detail}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "detail"),
    [(409, "You already have an agent with that slug."), (429, "You can have at most 20 agents.")],
)
async def test_string_details_are_still_forwarded(client, agents_service, seeded_user, status_code, detail):
    agents_service.on("POST", _custom_path(seeded_user.id), httpx.Response(status_code, json={"detail": detail}))

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom", json=_WRITE_BODY)

    assert response.status_code == status_code
    assert response.json() == {"detail": detail}


@pytest.mark.asyncio
async def test_a_list_detail_is_not_forwarded(client, agents_service, seeded_user):
    """FastAPI's own validation format echoes the request input; it is replaced
    by the bridge's public message, keeping the status."""
    agents_service.on(
        "POST", _custom_path(seeded_user.id),
        httpx.Response(422, json={"detail": [{"loc": ["body"], "msg": "bad", "input": "echoed input"}]}),
    )

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom", json=_WRITE_BODY)

    assert response.status_code == 422
    assert response.json() == {"detail": "The agent could not be created. Please try again."}


@pytest.mark.asyncio
async def test_render_returns_the_draft_as_yaml_without_a_catalog_row(
    client, agents_service, seeded_user, session_factory
):
    """The builder's YAML view renders an unsaved draft: the body goes upstream
    as it is, the text comes back, and no catalog row is read or written."""
    rendered = {"yaml": "id: research-bot-v1\nslug: research-bot\nname: Research Bot\n"}
    agents_service.on("POST", _custom_path(seeded_user.id, "/render"), httpx.Response(200, json=rendered))

    async def row_count() -> int:
        async with session_factory() as session:
            return (await session.execute(select(func.count()).select_from(AgentTable))).scalar_one()

    before = await row_count()
    response = await client.post(f"/v1/agents/{seeded_user.id}/custom/render", json=_WRITE_BODY)

    assert response.status_code == 200
    assert response.json() == rendered
    sent = agents_service.called("POST", _custom_path(seeded_user.id, "/render"))[0]
    assert json.loads(sent.content) == _WRITE_BODY
    assert await row_count() == before


@pytest.mark.asyncio
async def test_render_upstream_failure_is_a_generic_502(client, agents_service, seeded_user):
    agents_service.on(
        "POST", _custom_path(seeded_user.id, "/render"),
        httpx.Response(500, json={"detail": "Traceback: secret internals"}),
    )

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom/render", json=_WRITE_BODY)

    assert response.status_code == 502
    assert "secret" not in response.text


def test_render_is_session_scoped_and_csrf_protected():
    """Mounted like validate: the path user must be the session's, and it is a POST
    carrying a CSRF token — a literal segment declared before ``{agent_id}``."""
    from core.auth.session import require_csrf_protection
    from router import user_agents as routes
    from utils import validate_userId

    paths = [route.path for route in routes.router.routes]
    assert paths.index("/{user_id}/custom/render") < paths.index("/{user_id}/custom/{agent_id}")
    route = next(r for r in routes.router.routes if r.path == "/{user_id}/custom/render")
    calls = {dep.call for dep in route.dependant.dependencies}
    assert require_csrf_protection in calls and validate_userId in calls


@pytest.mark.asyncio
async def test_an_upstream_server_error_stays_a_generic_502(client, agents_service, seeded_user):
    agents_service.on(
        "POST", _custom_path(seeded_user.id),
        httpx.Response(500, json={"detail": "Traceback: secret internals"}),
    )

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom", json=_WRITE_BODY)

    assert response.status_code == 502
    assert "secret" not in response.text


# ---------------------------------------------------------------------------
# Compensation: a failed commit must not orphan the upstream definition (B9)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_a_failed_commit_deletes_the_upstream_definition_and_reraises(
    client, agents_service, seeded_user, session_factory, monkeypatch
):
    agents_service.on("POST", _custom_path(seeded_user.id), httpx.Response(201, json=_summary()))
    agents_service.on("DELETE", _custom_path(seeded_user.id, "/research-bot"), httpx.Response(204))

    async with session_factory() as session:
        async def failing_commit():
            raise SQLAlchemyError("connection lost")

        monkeypatch.setattr(session, "commit", failing_commit)
        with pytest.raises(SQLAlchemyError):
            await ua.create_custom_agent(session, seeded_user.id, _WRITE_BODY)

    assert len(agents_service.called("DELETE", _custom_path(seeded_user.id, "/research-bot"))) == 1
    async with session_factory() as session:
        assert await ua.list_custom_agent_definitions(session, seeded_user.id) == []


@pytest.mark.asyncio
async def test_a_failed_compensation_still_reraises_the_original_error(
    client, agents_service, seeded_user, session_factory, monkeypatch
):
    agents_service.on("POST", _custom_path(seeded_user.id), httpx.Response(201, json=_summary()))
    agents_service.on("DELETE", _custom_path(seeded_user.id, "/research-bot"), httpx.Response(500))

    async def failing_upsert(*args, **kwargs):
        raise RuntimeError("row write failed")

    monkeypatch.setattr(ua, "_upsert_row", failing_upsert)
    async with session_factory() as session:
        with pytest.raises(RuntimeError, match="row write failed"):
            await ua.create_custom_agent(session, seeded_user.id, _WRITE_BODY)

    assert agents_service.called("DELETE", _custom_path(seeded_user.id, "/research-bot"))


@pytest.mark.asyncio
async def test_a_refused_create_is_not_compensated(client, agents_service, seeded_user):
    """Nothing was written upstream, so there is nothing to delete."""
    agents_service.on("POST", _custom_path(seeded_user.id), httpx.Response(409, json={"detail": "taken"}))

    response = await client.post(f"/v1/agents/{seeded_user.id}/custom", json=_WRITE_BODY)

    assert response.status_code == 409
    assert [r.method for r in agents_service.calls] == ["POST"]


# ---------------------------------------------------------------------------
# The gallery's counts (include=summary) and kind
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_the_default_list_route_never_calls_upstream(
    client, agents_service, seeded_user, owned_agent_factory
):
    await owned_agent_factory()

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom")

    assert response.status_code == 200
    assert agents_service.calls == []
    [item] = response.json()
    assert item["kind"] == "custom"
    assert item["toolCount"] is None and item["model"] is None


@pytest.mark.asyncio
async def test_include_summary_merges_counts_by_slug_in_one_call(
    client, agents_service, seeded_user, owned_agent_factory
):
    counted_id = await owned_agent_factory("research-bot")
    plain_id = await owned_agent_factory("second-bot")
    agents_service.on(
        "GET", _custom_path(seeded_user.id),
        httpx.Response(200, json=[_summary("research-bot"), {"slug": "unknown-bot", "tool_count": 9}]),
    )

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom", params={"include": "summary"})

    assert response.status_code == 200
    assert len(agents_service.calls) == 1
    by_id = {item["id"]: item for item in response.json()}
    assert set(by_id) == {counted_id, plain_id}
    counted = by_id[counted_id]
    assert (counted["model"], counted["toolCount"], counted["skillCount"], counted["subagentCount"]) == (
        "openai:gpt-5", 3, 1, 2,
    )
    assert by_id[plain_id]["toolCount"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply",
    [httpx.Response(500), httpx.Response(200, json={"not": "a list"})],
    ids=["upstream-error", "malformed"],
)
async def test_include_summary_falls_back_to_the_rows_when_upstream_fails(
    client, agents_service, seeded_user, owned_agent_factory, reply
):
    await owned_agent_factory()
    agents_service.on("GET", _custom_path(seeded_user.id), reply)

    response = await client.get(f"/v1/agents/{seeded_user.id}/custom", params={"include": "summary"})

    assert response.status_code == 200
    [item] = response.json()
    assert item["name"] == "Research Bot" and item["toolCount"] is None


@pytest.mark.asyncio
async def test_include_summary_survives_an_unreachable_agents_service(
    client, seeded_user, owned_agent_factory, monkeypatch
):
    await owned_agent_factory()
    real = httpx.AsyncClient

    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: real(transport=httpx.MockTransport(refuse))
    )
    response = await client.get(f"/v1/agents/{seeded_user.id}/custom", params={"include": "summary"})

    assert response.status_code == 200
    assert len(response.json()) == 1


@pytest.mark.asyncio
async def test_the_catalog_marks_each_agent_platform_or_custom(
    app, client, seeded_user, seeded_agent, owned_agent_factory, monkeypatch
):
    from core.auth.session import require_current_user
    from router import catalog as catalog_router

    async def current_user():
        return seeded_user

    app.dependency_overrides[require_current_user] = current_user
    monkeypatch.setattr(catalog_router, "get_cached_agents", lambda: [seeded_agent])
    own_id = await owned_agent_factory()

    response = await client.get("/v1/catalog/agents")

    kinds = {item["id"]: item["kind"] for item in response.json()}
    assert kinds == {seeded_agent.id: "platform", own_id: "custom"}
