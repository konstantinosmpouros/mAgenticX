"""``get_usable_agent`` and every user-facing path that resolves an agent id (B10).

A user may use the platform's agents and their own; someone else's private agent
must behave exactly like an id that does not exist — a 404, and no trace of its
name or description. Each call site is checked with all three: a platform
agent works, the caller's own works, another user's is a 404.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

import utils.agents as agents_util
import utils.memories as memories_mod
import utils.skills as skills_mod
import utils.titles
from core.database import AgentTable, UserTable
from router import catalog as catalog_router
from schema import ScheduledTaskCreate, ScheduledTaskUpdate
from utils import scheduled_tasks as scheduled_tasks_util


@pytest.fixture
def agent_rows(session_factory, seeded_user, seeded_agent):
    """Three agents by whose they are: ``platform``, ``own`` and ``foreign``."""

    async def make() -> dict[str, AgentTable]:
        async with session_factory() as session:
            other = UserTable(username="someone-else", oidc_subject="oid-someone-else", is_active=True)
            session.add(other)
            await session.flush()
            own = AgentTable(owner_user_id=seeded_user.id, slug="my-bot", name="My Bot",
                             description="mine", icon="Bot", type="deep agent", is_active=True)
            foreign = AgentTable(owner_user_id=other.id, slug="their-bot", name="SECRET NAME",
                                 description="SECRET DESCRIPTION", icon="Bot", type="deep agent",
                                 is_active=True)
            session.add_all([own, foreign])
            await session.commit()
            return {"platform": seeded_agent, "own": own, "foreign": foreign}

    return make


@pytest.fixture
def own_sessions(monkeypatch, session_factory):
    """Point the helper's own short-lived session (``db=None`` callers) at the test DB."""
    monkeypatch.setattr(agents_util, "SessionLocal", session_factory)


# ---------------------------------------------------------------------------
# The helper itself
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("which", ["platform", "own"])
async def test_platform_and_own_agents_are_usable(agent_rows, session_factory, seeded_user, which):
    agents = await agent_rows()
    async with session_factory() as session:
        agent = await agents_util.get_usable_agent(session, seeded_user.id, agents[which].id)
    assert agent.id == agents[which].id


@pytest.mark.parametrize("agent_id", ["foreign", "inactive", "missing", None])
async def test_anything_else_is_the_same_404(agent_rows, session_factory, seeded_user, agent_id):
    agents = await agent_rows()
    if agent_id == "inactive":
        async with session_factory() as session:
            row = await session.get(AgentTable, agents["own"].id)
            row.is_active = False
            await session.commit()
        agent_id = agents["own"].id
    elif agent_id == "foreign":
        agent_id = agents["foreign"].id

    async with session_factory() as session:
        with pytest.raises(HTTPException) as exc:
            await agents_util.get_usable_agent(session, seeded_user.id, agent_id)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Agent not found."


async def test_without_a_session_it_opens_its_own(agent_rows, own_sessions, seeded_user):
    agents = await agent_rows()
    assert (await agents_util.get_usable_agent(None, seeded_user.id, agents["own"].id)).slug == "my-bot"
    with pytest.raises(HTTPException):
        await agents_util.get_usable_agent(None, seeded_user.id, agents["foreign"].id)


# ---------------------------------------------------------------------------
# POST /v1/conversations/{user}
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(("which", "expected"), [("platform", 201), ("own", 201), ("foreign", 404)])
async def test_create_conversation(client, agent_rows, seeded_user, monkeypatch, which, expected):
    agents = await agent_rows()

    async def no_title(_first_message):
        return None

    monkeypatch.setattr(utils.titles, "generate_conversation_title", no_title)
    response = await client.post(
        f"/v1/conversations/{seeded_user.id}",
        json={
            "agentId": agents[which].id,
            "firstMessage": {"sender": "user", "type": "text", "content": "Hello there"},
        },
    )
    assert response.status_code == expected
    assert "SECRET" not in response.text


# ---------------------------------------------------------------------------
# GET /v1/catalog/{user}/suggestions — used to leak the name and description
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(("which", "expected"), [("platform", 200), ("own", 200), ("foreign", 404)])
async def test_suggestions(client, agent_rows, seeded_user, monkeypatch, which, expected):
    agents = await agent_rows()
    captured: dict = {}

    async def fake_suggestions(**kwargs):
        captured.update(kwargs)
        return ["One", "Two"]

    monkeypatch.setattr(catalog_router, "generate_conversation_suggestions", fake_suggestions)
    response = await client.get(
        f"/v1/catalog/{seeded_user.id}/suggestions", params={"agentId": agents[which].id}
    )

    assert response.status_code == expected
    if expected == 200:
        assert captured["agent_name"] == agents[which].name
    else:
        assert captured == {}  # the private name never reached the prompt
        assert "SECRET" not in response.text


# ---------------------------------------------------------------------------
# Scheduled tasks: create and update
# ---------------------------------------------------------------------------
_TASK = {"prompt": "x", "scheduleKind": "interval", "intervalSeconds": 3600}


@pytest.mark.parametrize(("which", "expected"), [("platform", 201), ("own", 201), ("foreign", 404)])
async def test_scheduled_task_create(client, agent_rows, seeded_user, which, expected):
    agents = await agent_rows()
    response = await client.post(
        f"/v1/scheduled-tasks/{seeded_user.id}", json={**_TASK, "agentId": agents[which].id}
    )
    assert response.status_code == expected


@pytest.mark.parametrize(("which", "expected"), [("platform", 200), ("own", 200), ("foreign", 404)])
async def test_scheduled_task_update(client, agent_rows, seeded_user, which, expected):
    agents = await agent_rows()
    created = await client.post(
        f"/v1/scheduled-tasks/{seeded_user.id}", json={**_TASK, "agentId": agents["platform"].id}
    )
    task_id = created.json()["id"]

    response = await client.patch(
        f"/v1/scheduled-tasks/{seeded_user.id}/{task_id}", json={"agentId": agents[which].id}
    )

    assert response.status_code == expected
    assert "SECRET" not in response.text


async def test_scheduled_task_util_checks_the_task_owner(agent_rows, session_factory, seeded_user):
    """``update_scheduled_task`` has no user argument; it checks against the
    task's own owner."""
    agents = await agent_rows()
    async with session_factory() as session:
        user = await session.get(UserTable, seeded_user.id)
        task = await scheduled_tasks_util.create_scheduled_task(
            session, user, ScheduledTaskCreate(**_TASK, agentId=agents["own"].id)
        )
        with pytest.raises(HTTPException) as exc:
            await scheduled_tasks_util.update_scheduled_task(
                session, task, ScheduledTaskUpdate(agentId=agents["foreign"].id)
            )
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# Slug resolution: skills, memories and per-agent tools
# ---------------------------------------------------------------------------
_EXPECTED_SLUG = {"platform": "test-agent", "own": "my-bot"}


@pytest.mark.parametrize("module", [skills_mod, memories_mod], ids=["skills", "memories"])
@pytest.mark.parametrize("which", ["platform", "own", "foreign"])
async def test_skills_and_memories_resolve_only_usable_agents(
    agent_rows, own_sessions, seeded_user, module, which
):
    agents = await agent_rows()
    if which == "foreign":
        with pytest.raises(HTTPException) as exc:
            await module._resolve_agent_slug(seeded_user.id, agents[which].id)
        assert exc.value.status_code == 404
    else:
        assert await module._resolve_agent_slug(seeded_user.id, agents[which].id) == _EXPECTED_SLUG[which]


@pytest.mark.parametrize("which", ["platform", "own", "foreign"])
async def test_agent_tools_resolve_only_usable_agents(agent_rows, session_factory, seeded_user, which):
    agents = await agent_rows()
    async with session_factory() as session:
        if which == "foreign":
            with pytest.raises(HTTPException) as exc:
                await agents_util._resolve_agent_slug(session, seeded_user.id, agents[which].id)
            assert exc.value.status_code == 404
        else:
            slug = await agents_util._resolve_agent_slug(session, seeded_user.id, agents[which].id)
            assert slug == _EXPECTED_SLUG[which]


async def test_the_tools_route_refuses_another_users_agent_before_upstream(
    client, agents_service, agent_rows, seeded_user
):
    agents = await agent_rows()
    response = await client.get(f"/v1/agents/{seeded_user.id}/{agents['foreign'].id}/tools")
    assert response.status_code == 404
    assert agents_service.calls == []


async def test_the_memories_route_refuses_another_users_agent(
    client, agents_service, agent_rows, own_sessions, seeded_user
):
    agents = await agent_rows()
    response = await client.get(f"/v1/memories/users/{seeded_user.id}/agents/{agents['foreign'].id}")
    assert response.status_code == 404
    assert agents_service.calls == []


async def test_a_platform_agents_tools_still_load(client, agents_service, agent_rows, seeded_user):
    agents = await agent_rows()
    agents_service.on(
        "GET", f"/agents/{seeded_user.id}/test-agent/tools",
        httpx.Response(200, json={"agentSlug": "test-agent", "tools": []}),
    )
    response = await client.get(f"/v1/agents/{seeded_user.id}/{agents['platform'].id}/tools")
    assert response.status_code == 200
