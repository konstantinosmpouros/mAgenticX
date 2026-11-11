"""Reasoning effort per message on the bridge.

The composer lets the user pick how hard a reasoning model thinks on one turn.
Pinned here:

* ``MessageIn.effort`` takes the five levels, only on a user message, and an
  unknown level is a 422 at the API;
* the level is stored on the user message (``messages.effort``), comes back on
  ``MessageOut``, rides the run context only when set (no key otherwise), and a
  fork keeps it;
* the composer queue parks it and re-sends it;
* ``GET /v1/agents/{user}/{agent}/model`` proxies the agents service's answer,
  refuses someone else's agent before any upstream call and turns an unknown
  level from upstream into a 502;
* the migration chain still has one head, with ``0048_message_effort`` in it.
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import selectinload

import utils.composer_queue as composer_queue
import utils.inference_runs as ir
import utils.inference_start as inference_start_module
from core.database import AgentTable, ConversationTable, MessageTable, UserTable
from schema import InferenceStartPayload, MessageIn, MessageOut, queued_message_from_column
from utils.conversations import clone_branch_to_conversation
from utils.effort import EFFORT_LEVELS, effort_context
from utils.inference_runs import inference_run_manager
from utils.inference_start import start_inference_flow

LEVELS = ["minimal", "low", "medium", "high", "xhigh"]
VERSIONS = (
    Path(__file__).resolve().parents[2] / "magenticx" / "dialogue_bridge" / "core" / "database" / "migrations" / "versions"
)


@pytest.fixture
def agent_lookup(monkeypatch, seeded_agent):
    """The start path and the run resolve the seeded agent without the cache."""

    async def agent_by_id(agent_id):
        return seeded_agent if agent_id == seeded_agent.id else None

    monkeypatch.setattr(inference_start_module, "get_agent_by_id", agent_by_id)
    monkeypatch.setattr(ir, "get_agent_by_id", agent_by_id)
    return agent_by_id


def _new(seeded_agent, effort: str | None) -> InferenceStartPayload:
    return InferenceStartPayload(
        mode="new", agentId=seeded_agent.id, title="t",
        message=MessageIn(sender="user", content="think about it", effort=effort),
    )


async def _user_message_of(session_factory, run_id: str) -> MessageTable:
    async with session_factory() as db:
        run = await db.get(MessageTable, run_id)
        return await db.get(
            MessageTable, run.parent_message_id, options=[selectinload(MessageTable.attachments)]
        )


# -- the message ------------------------------------------------------------------


@pytest.mark.parametrize("level", LEVELS)
def test_a_user_message_takes_every_level(level):
    assert MessageIn(sender="user", content="x", effort=level).effort == level


def test_the_levels_are_the_contract():
    assert list(EFFORT_LEVELS) == LEVELS


def test_an_unknown_level_and_effort_on_an_answer_are_refused():
    with pytest.raises(ValidationError):
        MessageIn(sender="user", content="x", effort="extreme")
    with pytest.raises(ValidationError):
        MessageIn(sender="user", content="x", effort="HIGH")
    with pytest.raises(ValidationError):
        MessageIn(sender="ai", content="x", effort="high")
    assert MessageIn(sender="user", content="x").effort is None


async def test_an_unknown_level_is_a_422_at_the_start_route(client, seeded_user, seeded_agent, monkeypatch):
    launched: list[str] = []
    monkeypatch.setattr(inference_run_manager, "launch", launched.append)
    response = await client.post(f"/v1/inference/runs/{seeded_user.id}/start", json={
        "mode": "new", "agentId": seeded_agent.id, "title": "t",
        "message": {"sender": "user", "content": "x", "effort": "ludicrous"},
    })
    assert response.status_code == 422
    assert launched == []


# -- stored, shown, forked ------------------------------------------------------------


async def test_the_effort_is_stored_on_the_user_message_and_shown(
    agent_lookup, session_factory, seeded_user, seeded_agent
):
    async with session_factory() as db:
        response = await start_inference_flow(db=db, user=seeded_user, payload=_new(seeded_agent, "high"))
    user_message = await _user_message_of(session_factory, response.message.id)
    assert user_message.effort == "high"
    assert MessageOut.model_validate(user_message).effort == "high"
    assert effort_context(user_message) == {"effort": "high"}


async def test_a_message_without_effort_stores_none(agent_lookup, session_factory, seeded_user, seeded_agent):
    async with session_factory() as db:
        response = await start_inference_flow(db=db, user=seeded_user, payload=_new(seeded_agent, None))
    user_message = await _user_message_of(session_factory, response.message.id)
    assert user_message.effort is None
    assert MessageOut.model_validate(user_message).effort is None
    assert effort_context(user_message) == {}


async def test_a_fork_keeps_the_effort(session_factory, seeded_user, seeded_agent):
    async with session_factory() as db:
        conversation = ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id,
                                         agent_name=seeded_agent.name, title="t", is_private=False)
        db.add(conversation)
        await db.flush()
        question = MessageTable(conversation_id=conversation.id, sender="user", content="q", effort="low")
        db.add(question)
        await db.flush()
        answer = MessageTable(conversation_id=conversation.id, sender="ai", content="a",
                              parent_message_id=question.id)
        db.add(answer)
        await db.commit()
        ids = [question.id, answer.id]
    async with session_factory() as db:
        source = await db.get(ConversationTable, conversation.id)
        loaded = {
            m.id: m for m in (await db.execute(
                select(MessageTable).where(MessageTable.id.in_(ids)).options(selectinload(MessageTable.attachments))
            )).scalars().all()
        }
        forked = await clone_branch_to_conversation(
            db=db, source_conv=source, branch=[loaded[i] for i in ids], forked_message_id=ids[-1]
        )
        await db.commit()
        forked_id = forked.id
    async with session_factory() as db:
        rows = (await db.execute(
            select(MessageTable).where(MessageTable.conversation_id == forked_id, MessageTable.sender == "user")
        )).scalars().all()
    assert [row.effort for row in rows] == ["low"]


# -- the run context ----------------------------------------------------------------


@pytest.mark.parametrize("level", LEVELS)
def test_the_run_context_carries_a_set_level(level):
    assert effort_context(SimpleNamespace(effort=level)) == {"effort": level}


def test_the_run_context_has_no_key_without_a_level():
    assert effort_context(None) == {}
    assert effort_context(SimpleNamespace(effort=None)) == {}
    assert effort_context(SimpleNamespace()) == {}
    # A value the schema never lets in is dropped, not forwarded.
    assert effort_context(SimpleNamespace(effort="turbo")) == {}
    assert effort_context(SimpleNamespace(effort=3)) == {}


class _Upstream:
    """The agents service at the stream seam, recording what each run sends."""

    def __init__(self) -> None:
        self.payloads: list[dict[str, Any]] = []

    async def stream(self, manager, run_id, run_meta, runtime, agent_url, request_payload) -> str:
        self.payloads.append(request_payload)
        return "completed"


@pytest.fixture
def upstream(monkeypatch, session_factory):
    fake = _Upstream()

    async def _do_stream(self, *args):
        return await fake.stream(self, *args)

    monkeypatch.setattr(ir.InferenceRunManager, "_do_stream", _do_stream)
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    return fake


async def _run_to_end(run_id: str) -> None:
    ir.InferenceRunManager.launch(inference_run_manager, run_id)
    task = inference_run_manager._tasks.get(run_id)
    if task is not None:
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.parametrize("effort", ["xhigh", None])
async def test_the_run_config_carries_effort_only_when_set(
    agent_lookup, upstream, session_factory, seeded_user, seeded_agent, effort
):
    async with session_factory() as db:
        response = await start_inference_flow(db=db, user=seeded_user, payload=_new(seeded_agent, effort))
    await _run_to_end(response.message.id)

    assert len(upstream.payloads) == 1
    context = upstream.payloads[0]["config"]["context"]
    if effort is None:
        assert "effort" not in context
    else:
        assert context["effort"] == effort


# -- the composer queue ------------------------------------------------------------


def test_the_queue_slot_keeps_a_valid_effort_and_refuses_an_unknown_one():
    base = {"content": "q", "command": None, "agent_id": "a1", "queued_at": "2026-11-11T10:00:00"}
    assert queued_message_from_column({**base, "effort": "medium"}).effort == "medium"
    assert queued_message_from_column(base).effort is None
    # Fail closed: an unreadable slot is dropped, never sent with a forged level.
    assert queued_message_from_column({**base, "effort": "ultra"}) is None


async def test_a_queued_message_is_sent_with_its_effort(monkeypatch, session_factory, seeded_user, seeded_agent):
    async with session_factory() as db:
        conversation = ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id,
                                         agent_name=seeded_agent.name, title="t", is_private=False)
        db.add(conversation)
        await db.flush()
        db.add(MessageTable(conversation_id=conversation.id, sender="user", content="first"))
        conversation.queued_message = {"content": "next", "command": None, "effort": "minimal",
                                       "agent_id": seeded_agent.id, "queued_at": "2026-11-11T10:00:00"}
        await db.commit()
        conversation_id = conversation.id

    sent: list[InferenceStartPayload] = []

    async def fake_start(*, db, user, payload):
        sent.append(payload)
        # A permanent refusal: the queue drops the message and starts nothing.
        raise HTTPException(status_code=400, detail="stop here")

    monkeypatch.setattr(composer_queue, "start_inference_flow", fake_start)
    assert await composer_queue.send_queued_message(conversation_id, session_factory=session_factory) is False
    assert len(sent) == 1
    assert sent[0].message.effort == "minimal"
    assert sent[0].message.content == "next"


# -- GET /v1/agents/{user}/{agent}/model ---------------------------------------------------


async def test_the_model_endpoint_proxies_the_agents_service(client, agents_service, seeded_user, seeded_agent):
    body = {"agentSlug": seeded_agent.slug, "model": "gpt-5", "efforts": ["low", "medium", "high"],
            "defaultEffort": "medium"}
    path = f"/agents/{seeded_user.id}/{seeded_agent.slug}/model"
    agents_service.on("GET", path, httpx.Response(200, json=body))

    response = await client.get(f"/v1/agents/{seeded_user.id}/{seeded_agent.id}/model")

    assert response.status_code == 200
    assert response.json() == body
    (call,) = agents_service.called("GET", path)
    assert call.headers.get("x-internal-proxy-secret")


async def test_a_model_without_efforts_is_passed_through(client, agents_service, seeded_user, seeded_agent):
    body = {"agentSlug": seeded_agent.slug, "model": None, "efforts": [], "defaultEffort": None}
    agents_service.on("GET", f"/agents/{seeded_user.id}/{seeded_agent.slug}/model", httpx.Response(200, json=body))
    response = await client.get(f"/v1/agents/{seeded_user.id}/{seeded_agent.id}/model")
    assert response.status_code == 200
    assert response.json() == body


async def test_an_unknown_level_from_upstream_is_a_502(client, agents_service, seeded_user, seeded_agent):
    agents_service.on(
        "GET", f"/agents/{seeded_user.id}/{seeded_agent.slug}/model",
        httpx.Response(200, json={"agentSlug": seeded_agent.slug, "model": "m", "efforts": ["max"],
                                  "defaultEffort": None}),
    )
    response = await client.get(f"/v1/agents/{seeded_user.id}/{seeded_agent.id}/model")
    assert response.status_code == 502


async def test_an_upstream_error_is_a_502_like_the_tools_route(client, agents_service, seeded_user, seeded_agent):
    # The bridge already 404s an agent the user may not use (below); an upstream
    # 404 for an agent the bridge knows is a disagreement between the services,
    # mapped like every other upstream HTTP error (``upstream_error_handler``).
    agents_service.on("GET", f"/agents/{seeded_user.id}/{seeded_agent.slug}/model",
                      httpx.Response(404, json={"detail": "Agent not found."}))
    response = await client.get(f"/v1/agents/{seeded_user.id}/{seeded_agent.id}/model")
    assert response.status_code == 502


async def test_someone_elses_agent_is_404_before_upstream(client, agents_service, seeded_user, session_factory):
    async with session_factory() as db:
        other = UserTable(username="other", oidc_subject="oid-other", is_active=True)
        db.add(other)
        await db.flush()
        theirs = AgentTable(owner_user_id=other.id, slug="theirs", name="Theirs", description="",
                            icon="bot", type="deep agent", is_active=True)
        db.add(theirs)
        await db.commit()
        agent_id = theirs.id
    response = await client.get(f"/v1/agents/{seeded_user.id}/{agent_id}/model")
    assert response.status_code == 404
    assert agents_service.calls == []


# -- the migration ------------------------------------------------------------------


def test_the_effort_migration_is_the_single_head():
    revisions: dict[str, str | None] = {}
    for path in VERSIONS.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        revision = re.search(r'^revision(?:\s*:\s*str)?\s*=\s*["\']([^"\']+)["\']', text, re.M).group(1)
        down = re.search(r'^down_revision[^=]*=\s*(?:["\']([^"\']+)["\']|None)', text, re.M)
        revisions[revision] = down.group(1) if down else None
    parents = {down for down in revisions.values() if down}
    heads = [rev for rev in revisions if rev not in parents]
    assert len(heads) == 1, f"the migration chain forks: {heads}"
    chain, current = [], heads[0]
    while current:
        chain.append(current)
        current = revisions[current]
    assert "0048_message_effort" in chain
    assert revisions["0048_message_effort"] == "0047_drop_scheduled_task_private"
