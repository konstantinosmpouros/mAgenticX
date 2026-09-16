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

import pytest

from core.database import AgentTable
from utils import user_agents as ua


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
