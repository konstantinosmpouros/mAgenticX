"""``PUT /v1/agents/{user}/{agent}/tools/approvals`` — the builder's save step 2.

Every approval choice made while building lands in one transaction, in the same
``user_agent_tool_prefs`` rows the Approvals tab edits one at a time. Pinned
here: the rows that result, the same refusals as the single-row route (unknown
key → 404, a change to a locked gate → 409), and that a refusal writes nothing.
"""
from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select

from core.database import AgentTable, UserAgentToolPrefTable

TOOLS = [
    {"key": "rag/sql_query", "name": "sql_query", "kind": "mcp", "group": "rag",
     "declared": True, "enabled": True, "approval": False, "approvalLocked": False},
    {"key": "write_file", "name": "write_file", "kind": "builtin", "group": "Filesystem",
     "declared": True, "enabled": True, "approval": True, "approvalLocked": False},
    {"key": "edit_file", "name": "edit_file", "kind": "builtin", "group": "Filesystem",
     "declared": True, "enabled": True, "approval": True, "approvalLocked": False},
    {"key": "execute", "name": "execute", "kind": "builtin", "group": "Execution",
     "declared": True, "enabled": True, "approval": True, "approvalLocked": True},
]


@pytest.fixture
def tools_upstream(agents_service, seeded_user, seeded_agent):
    agents_service.on(
        "GET", f"/agents/{seeded_user.id}/{seeded_agent.slug}/tools",
        httpx.Response(200, json={"agentSlug": seeded_agent.slug, "tools": TOOLS}),
    )
    return agents_service


async def _stored(session_factory, user_id: str, slug: str) -> dict[str, bool | None]:
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(UserAgentToolPrefTable).where(
                    UserAgentToolPrefTable.user_id == user_id,
                    UserAgentToolPrefTable.agent_slug == slug,
                )
            )
        ).scalars().all()
        return {r.tool_key: r.requires_approval for r in rows}


async def _put(client, user_id: str, agent_id: str, approvals: dict):
    return await client.put(
        f"/v1/agents/{user_id}/{agent_id}/tools/approvals", json={"approvals": approvals}
    )


async def test_every_choice_is_stored_and_the_fresh_rows_returned(
    client, tools_upstream, seeded_user, seeded_agent, session_factory
):
    response = await _put(client, seeded_user.id, seeded_agent.id, {
        "rag/sql_query": True,   # gate an ungated tool
        "write_file": False,     # clear a default gate
        "edit_file": True,       # same as its default: nothing to store
        "execute": True,         # locked, sent with its own value: skipped
    })

    assert response.status_code == 200
    approval = {row["key"]: row["approval"] for row in response.json()["tools"]}
    assert approval == {"rag/sql_query": True, "write_file": False, "edit_file": True, "execute": True}
    assert await _stored(session_factory, seeded_user.id, seeded_agent.slug) == {
        "rag/sql_query": True,
        "write_file": False,
    }


async def test_null_drops_a_choice_back_to_the_default(
    client, tools_upstream, seeded_user, seeded_agent, session_factory
):
    await _put(client, seeded_user.id, seeded_agent.id, {"rag/sql_query": True, "write_file": False})

    response = await _put(client, seeded_user.id, seeded_agent.id, {"rag/sql_query": None, "write_file": None})

    assert response.status_code == 200
    approval = {row["key"]: row["approval"] for row in response.json()["tools"]}
    assert approval["rag/sql_query"] is False and approval["write_file"] is True
    assert await _stored(session_factory, seeded_user.id, seeded_agent.slug) == {}


async def test_a_change_to_a_locked_gate_is_409_and_writes_nothing(
    client, tools_upstream, seeded_user, seeded_agent, session_factory
):
    response = await _put(client, seeded_user.id, seeded_agent.id, {"rag/sql_query": True, "execute": False})

    assert response.status_code == 409
    assert "cannot be changed" in response.json()["detail"]
    assert await _stored(session_factory, seeded_user.id, seeded_agent.slug) == {}


async def test_an_unknown_key_is_404_and_writes_nothing(
    client, tools_upstream, seeded_user, seeded_agent, session_factory
):
    response = await _put(client, seeded_user.id, seeded_agent.id, {"write_file": False, "no/such_tool": True})

    assert response.status_code == 404
    assert response.json()["detail"] == "That tool is not available for this agent."
    assert await _stored(session_factory, seeded_user.id, seeded_agent.slug) == {}


async def test_a_failed_write_rolls_the_whole_batch_back(
    client, tools_upstream, seeded_user, seeded_agent, session_factory, monkeypatch
):
    """All or nothing even past validation: the second write fails, the first
    must not survive it."""
    from utils import agent_tool_prefs

    real = agent_tool_prefs.set_approval
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk full")
        return await real(*args, **kwargs)

    monkeypatch.setattr(agent_tool_prefs, "set_approval", flaky)
    from utils import agents as agents_util

    async with session_factory() as session:
        with pytest.raises(RuntimeError):
            await agents_util.set_agent_tool_approvals(
                session, seeded_user.id, seeded_agent.id, {"rag/sql_query": True, "write_file": False}
            )

    assert await _stored(session_factory, seeded_user.id, seeded_agent.slug) == {}


async def test_another_users_agent_is_404_before_upstream(
    client, agents_service, seeded_user, session_factory
):
    from core.database import UserTable

    async with session_factory() as session:
        other = UserTable(username="approvals-other", oidc_subject="oid-approvals-other", is_active=True)
        session.add(other)
        await session.flush()
        row = AgentTable(owner_user_id=other.id, slug="private-bot", name="Private", description="",
                         icon="Bot", type="deep agent", is_active=True)
        session.add(row)
        await session.commit()
        agent_id = row.id

    response = await _put(client, seeded_user.id, agent_id, {"write_file": False})

    assert response.status_code == 404
    assert agents_service.calls == []


async def test_the_single_row_route_and_the_batch_write_the_same_rows(
    client, tools_upstream, seeded_user, seeded_agent, session_factory
):
    await client.post(
        f"/v1/agents/{seeded_user.id}/{seeded_agent.id}/tools/approval",
        json={"toolKey": "rag/sql_query", "approval": True},
    )
    after_single = await _stored(session_factory, seeded_user.id, seeded_agent.slug)

    await _put(client, seeded_user.id, seeded_agent.id, {"rag/sql_query": None})
    await _put(client, seeded_user.id, seeded_agent.id, {"rag/sql_query": True})

    assert after_single == await _stored(session_factory, seeded_user.id, seeded_agent.slug) == {
        "rag/sql_query": True
    }
