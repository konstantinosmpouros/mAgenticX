"""The authored definition of a custom agent lives in chat_db.

It used to exist only on the agents-service volume, which has no backup: losing
it left the catalog row pointing at nothing — an agent that listed in the UI and
failed at run time. These pin the properties that make Postgres the owner, since
none of them is visible from the HTTP surface alone.
"""

import pytest
from sqlalchemy import select

from core.database import AgentDefinitionFileTable, AgentTable
from utils import user_agents as ua


@pytest.fixture
def payload():
    return {
        "spec": {
            "id": "research-bot-v1",
            "slug": "research-bot",
            "name": "Research Bot",
            "type": "deep_agent",
            "prompt": "./AGENT.md",
        },
        "files": [
            {"path": "AGENT.md", "content": "You are Research Bot.", "encoding": "utf-8"},
            {"path": "subagents/writer.md", "content": "You write.", "encoding": "utf-8"},
        ],
    }


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


async def _files_for(session_factory, agent_id: str):
    async with session_factory() as session:
        result = await session.execute(
            select(AgentDefinitionFileTable)
            .where(AgentDefinitionFileTable.agent_id == agent_id)
            .order_by(AgentDefinitionFileTable.path)
        )
        return [(r.path, r.content) for r in result.scalars().all()]


@pytest.mark.asyncio
async def test_store_definition_persists_every_submitted_file(
    session_factory, owned_agent_factory, payload
):
    agent_id = await owned_agent_factory()
    async with session_factory() as session:
        await ua._store_definition(session, agent_id, payload)
        await session.commit()

    assert await _files_for(session_factory, agent_id) == [
        ("AGENT.md", "You are Research Bot."),
        ("subagents/writer.md", "You write."),
    ]


@pytest.mark.asyncio
async def test_store_definition_replaces_rather_than_merges(
    session_factory, owned_agent_factory, payload
):
    # A save rewrites the whole agent folder upstream, so a file the user did
    # not re-send is deleted there. Merging here would leave chat_db holding
    # files the volume no longer has — the two stores would diverge on edit.
    agent_id = await owned_agent_factory()
    async with session_factory() as session:
        await ua._store_definition(session, agent_id, payload)
        await session.commit()

    async with session_factory() as session:
        await ua._store_definition(
            session,
            agent_id,
            {"files": [{"path": "AGENT.md", "content": "Rewritten."}]},
        )
        await session.commit()

    assert await _files_for(session_factory, agent_id) == [("AGENT.md", "Rewritten.")]


@pytest.mark.asyncio
async def test_store_definition_skips_entries_with_no_path(
    session_factory, owned_agent_factory
):
    agent_id = await owned_agent_factory()
    async with session_factory() as session:
        await ua._store_definition(
            session,
            agent_id,
            {"files": [{"path": "  ", "content": "x"}, {"content": "y"}]},
        )
        await session.commit()

    assert await _files_for(session_factory, agent_id) == []


@pytest.mark.asyncio
async def test_detail_is_assembled_without_calling_the_agents_service(
    session_factory, seeded_user, owned_agent_factory, payload, monkeypatch
):
    # The point of the change: opening an agent in the builder must not depend
    # on the agents service being reachable.
    async def _explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("detail must not call upstream")

    monkeypatch.setattr(ua, "_proxy", _explode)

    agent_id = await owned_agent_factory()
    async with session_factory() as session:
        row = await session.get(AgentTable, agent_id)
        row.definition_spec = payload["spec"]
        await ua._store_definition(session, agent_id, payload)
        await session.commit()

    async with session_factory() as session:
        detail = await ua.get_custom_agent_definition(session, seeded_user.id, agent_id)

    assert detail["id"] == agent_id
    assert detail["slug"] == "research-bot"
    assert detail["spec"] == payload["spec"]
    assert [f["path"] for f in detail["files"]] == ["AGENT.md", "subagents/writer.md"]


@pytest.mark.asyncio
async def test_list_reads_rows_only(
    session_factory, seeded_user, owned_agent_factory, monkeypatch
):
    async def _explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("list must not call upstream")

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


@pytest.mark.asyncio
async def test_a_volume_only_definition_is_adopted_on_first_read(
    session_factory, seeded_user, owned_agent_factory, payload, monkeypatch
):
    # Agents created before this store have a row but no definition rows. The
    # first read must adopt what is on the volume — otherwise the builder opens
    # empty and the next save wipes a definition the user still has.
    calls = []

    async def _fake_proxy(method, url, **kwargs):
        calls.append((method, url))
        return {"spec": payload["spec"], "files": payload["files"]}

    monkeypatch.setattr(ua, "_proxy", _fake_proxy)
    agent_id = await owned_agent_factory()

    async with session_factory() as session:
        detail = await ua.get_custom_agent_definition(session, seeded_user.id, agent_id)

    assert detail["spec"] == payload["spec"]
    assert len(calls) == 1

    # Adopted, so the second read is local.
    monkeypatch.setattr(ua, "_proxy", None)
    async with session_factory() as session:
        again = await ua.get_custom_agent_definition(session, seeded_user.id, agent_id)
    assert [f["path"] for f in again["files"]] == ["AGENT.md", "subagents/writer.md"]


@pytest.mark.asyncio
async def test_adoption_failure_returns_an_empty_definition_not_an_error(
    session_factory, seeded_user, owned_agent_factory, monkeypatch
):
    # The folder is genuinely gone. The row survived, so the honest outcome is
    # an empty form the user can re-author — not a 500.
    from fastapi import HTTPException

    async def _fail(*args, **kwargs):
        raise HTTPException(status_code=502, detail="upstream down")

    monkeypatch.setattr(ua, "_proxy", _fail)
    agent_id = await owned_agent_factory()

    async with session_factory() as session:
        detail = await ua.get_custom_agent_definition(session, seeded_user.id, agent_id)

    assert detail["spec"] == {}
    assert detail["files"] == []
