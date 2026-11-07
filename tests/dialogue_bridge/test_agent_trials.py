"""The agent builder's "Try it" chat on the bridge (plan 40).

A trial runs the builder's draft, uncommitted, through the real run pipeline:
the start route writes a trial conversation (``is_trial``, always private) and
its run, stashes the draft in Redis, and ``_run`` sends it inline on the
stream and on every resume leg. These tests drive the routes with the agents
service faked at the HTTP edge (``agents_service``) and ``_run`` with the
upstream faked at the ``_do_stream`` / ``_do_resume`` seam, as the other run
tests do.
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

import utils.agent_trials as agent_trials
import utils.data_export as data_export
import utils.inference_runs as ir
import utils.runtime_reaps as runtime_reaps
from core.database import (
    AgentTable,
    ConversationTable,
    MessageTable,
    PendingRuntimeReapTable,
    UsageDailyTable,
    UserAgentToolPrefTable,
    UserTable,
)
from utils.inference_runs import inference_run_manager
from utils.trial_drafts import TrialDraft, overlay_approvals, trial_drafts
from utils.usage import compute_usage_summary, list_usage_conversations

VERSIONS = (
    Path(__file__).resolve().parents[2] / "magenticx" / "dialogue_bridge" / "core" / "database" / "migrations" / "versions"
)


def _spec(slug: str = "draft-bot", name: str = "Draft Bot") -> dict[str, Any]:
    return {
        "id": slug, "slug": slug, "name": name, "version": "0.1.0", "type": "deep agent",
        "icon": "sparkles", "description": "A draft", "prompt": "./AGENT.md",
        "model": {"provider": "openai", "name": "gpt-5"},
    }


def _draft(slug: str = "draft-bot", name: str = "Draft Bot") -> dict[str, Any]:
    return {"spec": _spec(slug, name), "files": [{"path": "AGENT.md", "content": "Be helpful.", "encoding": "utf-8"}]}


def _sent(draft: dict[str, Any]) -> dict[str, Any]:
    """The draft as the bridge forwards it: ``CustomAgentWrite`` dumped, as on Commit."""
    return {**draft, "files": [{**f, "size": None} for f in draft["files"]]}


def _body(**overrides: Any) -> dict[str, Any]:
    body = {"agentId": None, "conversationId": None, "message": "hello draft", "draft": _draft(), "approvals": {}}
    body.update(overrides)
    return body


def _valid(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"valid": True, "errors": [], "issues": []})


@pytest.fixture
def launched(monkeypatch) -> list[str]:
    """The route launches the run detached; record it instead."""
    runs: list[str] = []
    monkeypatch.setattr(inference_run_manager, "launch", runs.append)
    return runs


@pytest.fixture
def upstream(agents_service, seeded_user, session_factory, monkeypatch):
    """The agents service: validation passes, reaps succeed. The reap outbox
    and the sweeper open their own sessions — pointed at the test database."""
    agents_service.on("POST", f"/users/{seeded_user.id}/custom-agents/validate", _valid)
    monkeypatch.setattr(runtime_reaps, "SessionLocal", session_factory)
    monkeypatch.setattr(agent_trials, "SessionLocal", session_factory)
    monkeypatch.setattr(data_export, "SessionLocal", session_factory)
    return agents_service


def _reap_ok(agents_service, user_id: str, conversation_id: str) -> str:
    path = f"/users/{user_id}/conversations/{conversation_id}/reap"
    agents_service.on("POST", path, httpx.Response(204))
    # The reap stops the conversation's background tasks first (plan 41).
    agents_service.on("POST", "/tasks/cancel-scope", httpx.Response(200, json={"cancelled": 0}))
    return path


@pytest_asyncio.fixture
async def my_agent(session_factory, seeded_user) -> AgentTable:
    async with session_factory() as session:
        agent = AgentTable(
            owner_user_id=seeded_user.id, slug="my-agent", name="My Agent",
            description="Mine", icon="bot", type="deep agent", is_active=True,
        )
        session.add(agent)
        await session.commit()
        await session.refresh(agent)
        return agent


@pytest_asyncio.fixture
async def stranger(session_factory) -> tuple[UserTable, AgentTable, str]:
    """Another user, their agent, and their trial conversation."""
    async with session_factory() as session:
        user = UserTable(username="stranger", oidc_subject="oid-stranger", is_active=True)
        session.add(user)
        await session.flush()
        agent = AgentTable(owner_user_id=user.id, slug="their-agent", name="Theirs", description="",
                           icon="bot", type="deep agent", is_active=True)
        session.add(agent)
        await session.flush()
        conversation = ConversationTable(user_id=user.id, agent_id=None, agent_name="Draft", is_private=True,
                                         is_trial=True)
        session.add(conversation)
        await session.commit()
        return user, agent, conversation.id


async def _start(client, user_id: str, **overrides: Any) -> httpx.Response:
    return await client.post(f"/v1/agents/{user_id}/custom/try", json=_body(**overrides))


async def _conversation(session_factory, conversation_id: str) -> ConversationTable | None:
    async with session_factory() as session:
        return await session.get(ConversationTable, conversation_id)


# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------
async def test_a_new_draft_starts_a_private_trial_with_no_agent_row(
    client, seeded_user, session_factory, upstream, launched,
):
    response = await _start(client, seeded_user.id, approvals={"write_file": True})
    assert response.status_code == 201, response.text
    body = response.json()
    run_id, conversation_id = body["run"]["id"], body["detail"]["id"]
    assert launched == [run_id]
    # The draft's name stands in for the agent no row describes.
    assert body["detail"]["agent"]["id"] == "" and body["detail"]["agent"]["name"] == "Draft Bot"
    assert body["message"]["agentId"] is None and body["message"]["agentName"] == "Draft Bot"

    conversation = await _conversation(session_factory, conversation_id)
    assert conversation.agent_id is None and conversation.is_trial and conversation.is_private
    assert conversation.title is None
    stashed = await trial_drafts.get(run_id)
    assert stashed == TrialDraft(definition=_sent(_draft()), approvals={"write_file": True}, existing=False)
    # Checked by the agents service before anything was written.
    assert len(upstream.called("POST", f"/users/{seeded_user.id}/custom-agents/validate")) == 1


async def test_an_existing_agent_is_tried_on_its_own_row(
    client, seeded_user, session_factory, upstream, launched, my_agent,
):
    response = await _start(client, seeded_user.id, agentId=my_agent.id, draft=_draft("my-agent", "My Agent v2"))
    assert response.status_code == 201, response.text
    conversation = await _conversation(session_factory, response.json()["detail"]["id"])
    assert conversation.agent_id == my_agent.id and conversation.is_trial
    assert (await trial_drafts.get(response.json()["run"]["id"])).existing is True


async def test_send_continues_the_same_trial_after_its_last_message(
    client, seeded_user, session_factory, upstream, launched,
):
    first = (await _start(client, seeded_user.id)).json()
    # The first run ends (the detached task is not running in this test).
    async with session_factory() as session:
        run = await session.get(MessageTable, first["run"]["id"])
        run.streaming_status = "completed"
        conversation = await session.get(ConversationTable, first["detail"]["id"])
        conversation.active_assistant_message_id = None
        await session.commit()

    response = await _start(client, seeded_user.id, conversationId=first["detail"]["id"], message="and again")
    assert response.status_code == 201, response.text
    second = response.json()
    assert second["detail"]["id"] == first["detail"]["id"]
    async with session_factory() as session:
        user_message = await session.get(MessageTable, second["run"]["parentMessageId"])
        assert user_message.content == "and again"
        # Linear: the new question hangs off the previous answer.
        assert user_message.parent_message_id == first["run"]["id"]
        count = len((await session.execute(select(ConversationTable).where(ConversationTable.is_trial))).all())
    assert count == 1


async def test_a_second_message_while_a_run_is_active_is_a_409(client, seeded_user, upstream, launched):
    first = (await _start(client, seeded_user.id)).json()
    response = await _start(client, seeded_user.id, conversationId=first["detail"]["id"])
    assert response.status_code == 409


async def test_someone_elses_agent_or_conversation_is_a_404_before_any_upstream_call(
    client, seeded_user, upstream, launched, stranger,
):
    _user, their_agent, their_trial = stranger
    assert (await _start(client, seeded_user.id, agentId=their_agent.id)).status_code == 404
    assert (await _start(client, seeded_user.id, conversationId=their_trial)).status_code == 404
    assert (await _start(client, seeded_user.id, agentId="no-such-agent")).status_code == 404
    assert upstream.called("POST", f"/users/{seeded_user.id}/custom-agents/validate") == []
    assert launched == []


async def test_an_ordinary_conversation_cannot_be_continued_as_a_trial(
    client, seeded_user, upstream, launched, conversation_factory,
):
    ordinary = await conversation_factory(title="Real chat", messages=[{"content": "hi"}])
    response = await _start(client, seeded_user.id, conversationId=ordinary["conversation_id"])
    assert response.status_code == 404


async def test_an_invalid_draft_is_the_422_commit_shows(client, seeded_user, agents_service, launched):
    issue = {"path": "model", "message": "Unknown model.", "severity": "error"}
    agents_service.on(
        "POST", f"/users/{seeded_user.id}/custom-agents/validate",
        httpx.Response(200, json={"valid": False, "errors": ["Unknown model."], "issues": [issue]}),
    )
    response = await _start(client, seeded_user.id)
    assert response.status_code == 422
    assert response.json()["detail"] == {"message": "Unknown model.", "errors": ["Unknown model."], "issues": [issue]}
    assert launched == []


async def test_a_trial_of_a_saved_agent_cannot_change_its_slug(client, seeded_user, upstream, launched, my_agent):
    response = await _start(client, seeded_user.id, agentId=my_agent.id, draft=_draft("renamed"))
    assert response.status_code == 422
    assert [issue["path"] for issue in response.json()["detail"]["issues"]] == ["slug"]


async def test_a_blank_message_is_refused(client, seeded_user, upstream, launched):
    assert (await _start(client, seeded_user.id, message="   ")).status_code == 422


# ---------------------------------------------------------------------------
# The detached run
# ---------------------------------------------------------------------------
class FakeUpstream:
    """The agents service at the stream/resume seam, recording what it is sent."""

    def __init__(self, interrupt: bool = False) -> None:
        self.interrupt = interrupt
        self.streams: list[tuple[str, dict[str, Any]]] = []
        self.resumes: list[dict[str, Any]] = []

    async def stream(self, manager, run_id, run_meta, runtime, agent_url, request_payload) -> str:
        self.streams.append((agent_url, request_payload))
        events = [{"type": "CUSTOM", "name": "TOKEN_USAGE", "value": {
            "message_id": "m1", "input_tokens": 120, "output_tokens": 30, "model": "gpt-5"}}]
        if self.interrupt:
            events.append({"type": "CUSTOM", "name": "HITL_INTERRUPT", "value": {
                "interrupt": {"id": "int-1", "value": {"action_requests": [{"name": "write_file"}]}}}})
        applied = [e for e in (runtime.apply_event(event) for event in events) if e is not None]
        await manager._publish_delta(run_id, run_meta, runtime, applied)
        return "completed"

    async def resume(self, manager, run_id, run_meta, runtime, resume_url, base_config, payloads, **extra) -> str:
        self.resumes.append({"url": resume_url, "config": base_config, **extra})
        return "completed"


@pytest.fixture
def fake_upstream(monkeypatch, session_factory):
    fake = FakeUpstream()

    async def _do_stream(self, *args):
        return await fake.stream(self, *args)

    async def _do_resume(self, *args, **kwargs):
        return await fake.resume(self, *args, **kwargs)

    monkeypatch.setattr(ir.InferenceRunManager, "_do_stream", _do_stream)
    monkeypatch.setattr(ir.InferenceRunManager, "_do_resume", _do_resume)
    monkeypatch.setattr(ir, "SessionLocal", session_factory)
    return fake


def _launch(run_id: str) -> None:
    """The real launch (the ``launched`` fixture stubs the route's)."""
    ir.InferenceRunManager.launch(inference_run_manager, run_id)


async def _run_to_end(run_id: str, session_factory) -> MessageTable:
    _launch(run_id)
    task = inference_run_manager._tasks.get(run_id)
    if task is not None:
        await asyncio.wait_for(task, timeout=5)
    async with session_factory() as session:
        return await session.get(MessageTable, run_id)


async def test_a_new_draft_runs_from_its_definition_with_memory_off(
    client, seeded_user, session_factory, upstream, launched, fake_upstream, monkeypatch,
):
    body = (await _start(client, seeded_user.id, approvals={"write_file": True, "execute": None})).json()
    run = await _run_to_end(body["run"]["id"], session_factory)

    assert run.streaming_status == "completed"
    url, payload = fake_upstream.streams[0]
    assert url.endswith("/agents/draft-bot/stream")
    assert payload["definition"] == _sent(_draft())
    context = payload["config"]["context"]
    assert context["use_memory"] is False
    assert context["agent_owner_id"] == seeded_user.id
    assert context["tool_config"] == {"enabled": [], "disabled": [], "approvals": {"write_file": True}}
    # Read once, then dropped: the run holds it from here on.
    assert await trial_drafts.get(run.id) is None
    # The terminal frame describes the agentless conversation by the draft.
    async with session_factory() as session:
        frame = await ir.build_run_event_payload(session, run.id, "terminal")
    assert frame["summary"]["agent"]["name"] == "Draft Bot" and frame["summary"]["isPrivate"] is True


async def test_an_existing_agent_runs_with_real_memory_and_its_tool_rows_overlaid(
    client, seeded_user, session_factory, upstream, launched, fake_upstream, my_agent, monkeypatch,
):
    async with session_factory() as session:
        session.add_all([
            UserAgentToolPrefTable(user_id=seeded_user.id, agent_slug="my-agent", tool_key="web_search",
                                   state=None, requires_approval=True),
            UserAgentToolPrefTable(user_id=seeded_user.id, agent_slug="my-agent", tool_key="read_file",
                                   state=None, requires_approval=True),
        ])
        await session.commit()
    body = (await _start(client, seeded_user.id, agentId=my_agent.id, draft=_draft("my-agent"),
                         approvals={"web_search": None, "write_file": False})).json()

    async def agent_by_id(agent_id):
        return my_agent if agent_id == my_agent.id else None

    monkeypatch.setattr(ir, "get_agent_by_id", agent_by_id)
    run = await _run_to_end(body["run"]["id"], session_factory)

    assert run.streaming_status == "completed"
    url, payload = fake_upstream.streams[0]
    assert url.endswith("/agents/my-agent/stream")
    assert payload["definition"] == _sent(_draft("my-agent"))
    context = payload["config"]["context"]
    assert context["use_memory"] is True
    assert context["agent_owner_id"] == seeded_user.id
    # Saved rows, with the draft's choices on top — for this run only.
    assert context["tool_config"]["approvals"] == {"read_file": True, "write_file": False}
    async with session_factory() as session:
        rows = (await session.execute(select(UserAgentToolPrefTable.tool_key))).scalars().all()
    assert sorted(rows) == ["read_file", "web_search"]


async def test_every_resume_leg_carries_the_definition(
    client, seeded_user, session_factory, upstream, launched, fake_upstream, monkeypatch,
):
    fake_upstream.interrupt = True
    body = (await _start(client, seeded_user.id)).json()
    run_id = body["run"]["id"]
    _launch(run_id)

    deadline = asyncio.get_running_loop().time() + 5
    while not (inference_run_manager._runtimes.get(run_id) and inference_run_manager._runtimes[run_id].pending_interrupts):
        assert asyncio.get_running_loop().time() < deadline, "the run never paused"
        await asyncio.sleep(0.005)
    decision = {"interrupt_id": "int-1", "decision": "approve", "reason": None, "value": None, "decisions": None}
    assert inference_run_manager.request_resume(run_id, decision).accepted
    await asyncio.wait_for(inference_run_manager._tasks[run_id], timeout=5)

    assert len(fake_upstream.resumes) == 1
    leg = fake_upstream.resumes[0]
    assert leg["url"].endswith("/agents/draft-bot/resume")
    assert leg["definition"] == _sent(_draft())
    assert leg["config"]["context"]["use_memory"] is False


async def test_the_resume_body_sends_the_definition_on_the_wire(monkeypatch):
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, text="", headers={"content-type": "text/event-stream"})

    real = httpx.AsyncClient
    monkeypatch.setattr(ir.httpx, "AsyncClient",
                        lambda *a, **k: real(transport=httpx.MockTransport(handler), timeout=k.get("timeout")))
    config = {"run_config": {"configurable": {"thread_id": "t"}}, "context": {"run_id": "r"}}
    decision = {"interrupt_id": "int-1", "decision": "approve", "reason": None, "value": None, "decisions": None}
    await inference_run_manager._do_resume(
        "r", {}, ir.InferenceRunRuntime(), "http://agents.test/agents/x/resume", config, [decision],
        definition=_draft(),
    )
    await inference_run_manager._do_resume(
        "r", {}, ir.InferenceRunRuntime(), "http://agents.test/agents/x/resume", config, [decision],
    )
    assert bodies[0]["definition"] == _draft()
    assert "definition" not in bodies[1]


async def test_a_trial_run_whose_draft_expired_fails_cleanly(
    client, seeded_user, session_factory, upstream, launched, fake_upstream, monkeypatch,
):
    body = (await _start(client, seeded_user.id)).json()
    await trial_drafts.delete(body["run"]["id"])
    run = await _run_to_end(body["run"]["id"], session_factory)
    assert run.streaming_status == "failed" and "expired" in (run.error_message or "")
    assert fake_upstream.streams == []


async def test_a_trials_tokens_count_in_the_daily_rollups_under_the_drafts_name(
    client, seeded_user, session_factory, upstream, launched, fake_upstream, monkeypatch,
):
    body = (await _start(client, seeded_user.id)).json()
    await _run_to_end(body["run"]["id"], session_factory)
    async with session_factory() as session:
        day = (await session.execute(select(UsageDailyTable))).scalar_one()
        summary = await compute_usage_summary(session, seeded_user.id)
    assert (day.agent_key, day.agent_id, day.input_tokens, day.output_tokens) == ("name:Draft Bot", None, 120, 30)
    # Counted, never listed: the conversation count leaves the trial out.
    assert summary.conversations == 0


def test_the_draft_approvals_overlay_the_saved_config_only_for_the_run():
    saved = {"enabled": ["a/x"], "disabled": ["b/y"], "approvals": {"keep": True, "drop": True, "flip": True}}
    merged = overlay_approvals(saved, {"drop": None, "flip": False, "new": True})
    assert merged == {"enabled": ["a/x"], "disabled": ["b/y"], "approvals": {"flip": False, "keep": True, "new": True}}
    assert saved["approvals"] == {"keep": True, "drop": True, "flip": True}


# ---------------------------------------------------------------------------
# Exclusions
# ---------------------------------------------------------------------------
async def test_a_trial_is_invisible_everywhere_but_the_trial_routes(
    client, seeded_user, session_factory, upstream, launched, conversation_factory,
):
    ordinary = await conversation_factory(title="hello world chat", messages=[{"content": "hello world"}])
    trial = (await _start(client, seeded_user.id, message="hello world from a trial")).json()
    trial_id = trial["detail"]["id"]
    async with session_factory() as session:
        conversation = await session.get(ConversationTable, trial_id)
        conversation.usage_answers = 1
        conversation.usage_total_tokens = 150
        conversation.usage_updated_at = ir._now()
        await session.commit()
    uid = seeded_user.id

    listed = (await client.get(f"/v1/conversations/{uid}")).json()["items"]
    assert [c["id"] for c in listed] == [ordinary["conversation_id"]]
    for path in (f"/v1/conversations/{uid}/archived", f"/v1/conversations/{uid}/pinned"):
        assert trial_id not in [c["id"] for c in (await client.get(path)).json()["items"]]

    found = (await client.get(f"/v1/search/{uid}", params={"q": "hello world"})).json()
    assert all(item.get("conversationId") != trial_id for item in found)

    active = (await client.get(f"/v1/inference/runs/{uid}", params={"status": "active"})).json()
    assert trial["run"]["id"] not in [run["id"] for run in active]
    everything = (await client.get(f"/v1/inference/runs/{uid}")).json()
    assert trial["run"]["id"] not in [run["id"] for run in everything]

    # Every conversation route treats it as not found.
    assert (await client.get(f"/v1/conversations/{uid}/{trial_id}")).status_code == 404
    assert (await client.patch(f"/v1/conversations/{uid}/{trial_id}/title", json={"title": "x"})).status_code == 404
    assert (await client.delete(f"/v1/conversations/{uid}/{trial_id}")).status_code == 404

    exported = [cid async for cid in data_export._conversation_ids(uid)]
    assert exported == [ordinary["conversation_id"]]
    rows = [row["id"] async for row in data_export._conversation_rows(uid)]
    assert rows == [ordinary["conversation_id"]]

    async with session_factory() as session:
        page = await list_usage_conversations(session, uid, sort="tokens", range_key="all", agent_id=None,
                                              query=None, cursor=None, limit=20)
    assert page.items == [] and page.private is None


# ---------------------------------------------------------------------------
# Reset and the sweeper
# ---------------------------------------------------------------------------
async def test_reset_deletes_the_trial_and_reaps_its_runtime(
    client, seeded_user, session_factory, upstream, launched,
):
    trial = (await _start(client, seeded_user.id)).json()
    trial_id = trial["detail"]["id"]
    reap = _reap_ok(upstream, seeded_user.id, trial_id)

    response = await client.delete(f"/v1/agents/{seeded_user.id}/custom/try/{trial_id}")
    assert response.status_code == 204
    assert await _conversation(session_factory, trial_id) is None
    assert len(upstream.called("POST", reap)) == 1
    async with session_factory() as session:
        assert (await session.execute(select(PendingRuntimeReapTable))).all() == []


async def test_reset_refuses_anything_but_the_callers_trial(
    client, seeded_user, session_factory, upstream, conversation_factory, stranger,
):
    ordinary = await conversation_factory(title="Keep me")
    _user, _agent, their_trial = stranger
    for conversation_id in (ordinary["conversation_id"], their_trial, "missing"):
        response = await client.delete(f"/v1/agents/{seeded_user.id}/custom/try/{conversation_id}")
        assert response.status_code == 404
    assert await _conversation(session_factory, ordinary["conversation_id"]) is not None
    assert await _conversation(session_factory, their_trial) is not None


async def test_the_sweeper_deletes_only_trials_older_than_the_ttl(
    session_factory, seeded_user, seeded_agent, upstream,
):
    old = ir._now() - timedelta(hours=25)
    async with session_factory() as session:
        expired = ConversationTable(user_id=seeded_user.id, agent_id=None, agent_name="Draft", is_private=True,
                                    is_trial=True, created_at=old)
        fresh = ConversationTable(user_id=seeded_user.id, agent_id=None, agent_name="Draft", is_private=True,
                                  is_trial=True)
        old_chat = ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id, agent_name="Test",
                                     is_private=True, created_at=old)
        session.add_all([expired, fresh, old_chat])
        await session.commit()
        ids = (expired.id, fresh.id, old_chat.id)
    reap = _reap_ok(upstream, seeded_user.id, ids[0])

    assert await agent_trials.sweep_expired_trials_once() == 1
    assert await _conversation(session_factory, ids[0]) is None
    assert await _conversation(session_factory, ids[1]) is not None
    assert await _conversation(session_factory, ids[2]) is not None
    assert len(upstream.called("POST", reap)) == 1
    assert await agent_trials.sweep_expired_trials_once() == 0


async def test_the_sweeper_loop_stops_when_asked(monkeypatch):
    calls: list[int] = []

    async def sweep() -> int:
        calls.append(1)
        return 0

    monkeypatch.setattr(agent_trials, "sweep_expired_trials_once", sweep)
    stop = asyncio.Event()
    task = asyncio.create_task(agent_trials.run_trial_sweeper(stop))
    await asyncio.sleep(0.01)
    stop.set()
    await asyncio.wait_for(task, timeout=2)
    assert calls == [1]


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
async def test_only_a_trial_may_have_no_agent(session_factory, seeded_user):
    async with session_factory() as session:
        session.add(ConversationTable(user_id=seeded_user.id, agent_id=None, agent_name="x", is_private=True))
        with pytest.raises(IntegrityError):
            await session.commit()


def test_the_trial_migration_sits_in_a_single_head_chain():
    """One head (no fork in the migration chain), with the trial migration in it
    on top of 0042. Later migrations go on top: the head is not pinned."""
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
    assert "0043_trial_conversations" in chain
    assert revisions["0043_trial_conversations"] == "0042_conversation_files"
