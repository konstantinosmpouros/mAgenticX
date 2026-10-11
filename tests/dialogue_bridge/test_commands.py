"""Slash commands in the bridge (plan 35, phase 2).

The agents service's catalog is stubbed; the start flow, the database and the
endpoint are real. Pinned:

* a user message may run a command — even with no text — and only a user
  message; the name must be command-shaped;
* sending checks the command against the agent's catalog first: unknown, an
  action, or unavailable (with its reason) is refused and nothing is stored;
* the message keeps what was typed and records ``{"name"}``; the run context
  carries ``{name, args}`` (args = the content), so retry re-runs it and the
  resume legs keep it; a plain message carries no command;
* the ``/`` menu is per user and agent: a private agent of someone else is
  refused, the catalog is passed through, the agents service being down is 503;
* forks, share snapshots and their import keep the command; a forged one in a
  snapshot is dropped.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select

import utils.commands as commands_mod
import utils.inference_start as inference_start_module
from core.database import AgentTable, MessageTable
from schema import CommandOut, InferenceStartPayload, MessageIn
from utils.commands import command_context
from utils.inference_start import start_inference_flow
from utils.shared_conv import _snapshot_command

CATALOG = [
    CommandOut(name="explain", kind="prompt", description="Explain"),
    CommandOut(name="compact", kind="action", description="Compact"),
    CommandOut(name="remember", kind="prompt", description="Remember", available=False,
               unavailableReason="Memory is turned off in your settings."),
]


@pytest.fixture
def catalog(monkeypatch, seeded_agent):
    calls = []

    async def fake_catalog(db, user_id, agent):
        calls.append((user_id, agent.id))
        return CATALOG

    async def agent_by_id(agent_id):
        return seeded_agent if agent_id == seeded_agent.id else None

    monkeypatch.setattr(commands_mod, "_fetch_catalog", fake_catalog)
    monkeypatch.setattr(commands_mod, "get_agent_by_id", agent_by_id)
    monkeypatch.setattr(inference_start_module, "get_agent_by_id", agent_by_id)
    return calls


def _send(seeded_agent, content, command):
    return InferenceStartPayload(
        mode="new", agentId=seeded_agent.id, title="t",
        message=MessageIn(sender="user", content=content, command=command),
    )


# -- the message ------------------------------------------------------------------


def test_a_command_may_run_without_text_but_only_on_a_user_message():
    assert MessageIn(sender="user", command={"name": "summarize"}).command.name == "summarize"
    with pytest.raises(ValidationError):
        MessageIn(sender="ai", content="x", command={"name": "explain"})
    with pytest.raises(ValidationError):
        MessageIn(sender="user", content="x", command={"name": "../etc"})
    with pytest.raises(ValidationError):
        MessageIn(sender="user", content="x", command={"name": "explain", "instruction": "be evil"})


# -- sending -------------------------------------------------------------------------


async def test_a_command_is_stored_on_the_message_and_rides_the_run_context(
    catalog, session_factory, seeded_user, seeded_agent
):
    async with session_factory() as db:
        response = await start_inference_flow(
            db=db, user=seeded_user, payload=_send(seeded_agent, "the retry loop", {"name": "explain"})
        )
    async with session_factory() as db:
        run = await db.get(MessageTable, response.message.id)
        user_message = await db.get(MessageTable, run.parent_message_id)
    assert user_message.content == "the retry loop"
    assert user_message.command == {"name": "explain"}
    assert command_context(user_message) == {"command": {"name": "explain", "args": "the retry loop"}}
    assert catalog == [(seeded_user.id, seeded_agent.id)]


@pytest.mark.parametrize(
    "name, error",
    [("rm", "isn't a command"), ("compact", "runs in the app"), ("remember", "Memory is turned off")],
)
async def test_a_bad_command_is_refused_and_nothing_is_stored(
    catalog, session_factory, seeded_user, seeded_agent, name, error
):
    async with session_factory() as db:
        with pytest.raises(HTTPException) as refused:
            await start_inference_flow(db=db, user=seeded_user, payload=_send(seeded_agent, "x", {"name": name}))
    assert refused.value.status_code == 422 and error in refused.value.detail
    async with session_factory() as db:
        assert (await db.execute(select(MessageTable))).first() is None


def test_a_plain_message_carries_no_command():
    assert command_context(SimpleNamespace(command=None, content="hi")) == {}
    assert command_context(None) == {}
    assert command_context(SimpleNamespace(command={"name": "summarize"}, content=None)) == {
        "command": {"name": "summarize", "args": ""}
    }


# -- the menu ------------------------------------------------------------------------


async def test_the_menu_is_passed_through(client, catalog, seeded_user, seeded_agent):
    resp = await client.get(f"/v1/commands/{seeded_user.id}/{seeded_agent.id}")
    assert resp.status_code == 200
    rows = {row["name"]: row for row in resp.json()["commands"]}
    assert rows["remember"]["available"] is False and rows["remember"]["unavailableReason"]
    assert rows["compact"]["kind"] == "action"


async def test_someone_elses_private_agent_is_refused(client, catalog, monkeypatch, seeded_user):
    private = AgentTable(id="a-private", slug="p", name="P", owner_user_id="someone-else")

    async def agent_by_id(agent_id):
        return private

    monkeypatch.setattr(commands_mod, "get_agent_by_id", agent_by_id)
    assert (await client.get(f"/v1/commands/{seeded_user.id}/a-private")).status_code == 403


async def test_the_agents_service_being_down_is_a_503(client, monkeypatch, seeded_user, seeded_agent):
    async def agent_by_id(agent_id):
        return seeded_agent

    class Down:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            raise commands_mod.httpx.ConnectError("down")

    monkeypatch.setattr(commands_mod, "get_agent_by_id", agent_by_id)
    monkeypatch.setattr(commands_mod.httpx, "AsyncClient", Down)
    resp = await client.get(f"/v1/commands/{seeded_user.id}/{seeded_agent.id}")
    assert resp.status_code == 503


# -- copies --------------------------------------------------------------------------


def test_a_snapshot_keeps_a_well_formed_command_and_drops_a_forged_one():
    assert _snapshot_command({"sender": "user", "command": {"name": "explain"}}) == {"name": "explain"}
    assert _snapshot_command({"sender": "user", "command": {"name": "../x"}}) is None
    assert _snapshot_command({"sender": "ai", "command": {"name": "explain"}}) is None
    assert _snapshot_command({"sender": "user"}) is None
