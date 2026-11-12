"""Citation sources — the bridge's half (plan 42, inline citations).

The agents service stores the sources a conversation's search tools returned;
the bridge:

* serves them to the conversation's owner (``GET …/sources``), re-validated on
  the way out and failing open to an empty list when the agents service is
  unreachable;
* copies them on fork and drops them with the conversation's reap;
* freezes the cited ones into a share snapshot, so the public view resolves
  its markers without a session;
* passes the live ``SOURCES`` CUSTOM event through the run's event log intact.
"""
from __future__ import annotations

import json
from copy import deepcopy
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

import utils.async_tasks as async_tasks
import utils.runtime_reaps as runtime_reaps
from core.auth.session import require_current_user
from core.database import ConversationTable, MessageTable, PendingRuntimeReapTable
from core.settings import settings
from schema import ConversationSource, ConversationSourcesOut, keep_valid_sources
from utils.agents import copy_conversation_sources
from utils.inference_runs import InferenceRunRuntime, append_coalesced, truncate_tool_result
from utils.task_streams import task_events_key, task_streams
from utils.validators import validate_userId

GOOD = {"id": "3fa2c1", "url": "https://example.com/a", "title": "A page", "snippet": "Some text", "tool": "tavily-search"}
OTHER = {"id": "9b02e4", "url": "http://arxiv.org/abs/1", "title": "Paper", "snippet": "Abstract", "tool": "search_papers"}

SOURCES_EVENT = {
    "type": "CUSTOM",
    "name": "SOURCES",
    "value": {"tool_call_id": "c1", "sources": [GOOD, OTHER]},
}


def _sources_path(user_id: str, conversation_id: str) -> str:
    return f"/users/{user_id}/conversations/{conversation_id}/sources"


async def _conversation(session_factory, user_id: str, agent, *, is_trial: bool = False, content: str = "") -> str:
    async with session_factory() as s:
        conv = ConversationTable(user_id=user_id, agent_id=agent.id, agent_name=agent.name, title="t",
                                 is_trial=is_trial, is_private=is_trial)
        s.add(conv)
        await s.flush()
        question = MessageTable(conversation_id=conv.id, sender="user", content="Question")
        s.add(question)
        await s.flush()
        s.add(MessageTable(conversation_id=conv.id, sender="ai", parent_message_id=question.id,
                           content=content or "Answer", raw_events=[{"type": "RUN_FINISHED"}]))
        await s.commit()
        return conv.id


# ---------------------------------------------------------------------------
# The schema: nothing from upstream is trusted
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("url", [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/relative/path",
    "ftp://example.com/file",
    "https://",
    "https://example.com/a b",
    " https://example.com/",
    "https://example.com/\x00",
    "https://example.com/" + "a" * 2048,
])
def test_a_bad_url_drops_the_source(url):
    assert keep_valid_sources([{**GOOD, "url": url}, OTHER]) == [ConversationSource.model_validate(OTHER)]


@pytest.mark.parametrize("source_id", ["3FA2C1", "3fa2c", "3fa2c1abc", "zzzzzz", "", None])
def test_a_bad_id_drops_the_source(source_id):
    assert keep_valid_sources([{**GOOD, "id": source_id}]) == []


def test_text_is_capped_and_control_characters_are_stripped():
    [source] = keep_valid_sources([{
        **GOOD,
        "title": "Line\none\x07\x1b[31m" + "t" * 400,
        "snippet": "s" * 400,
        "tool": "x" * 200,
    }])
    assert source.title.startswith("Line one[31m") and len(source.title) == 300
    assert len(source.snippet) == 300 and len(source.tool) == 100


def test_duplicates_and_the_cap_and_non_lists():
    many = [{**GOOD, "id": f"{i:06x}"} for i in range(600)]
    assert len(keep_valid_sources(many)) == 500
    assert keep_valid_sources([GOOD, GOOD]) == [ConversationSource.model_validate(GOOD)]
    assert keep_valid_sources({"sources": [GOOD]}) == []
    assert keep_valid_sources(None) == []
    assert ConversationSourcesOut(sources=[GOOD, {"id": "bad"}, "junk"]).sources == [
        ConversationSource.model_validate(GOOD)
    ]


# ---------------------------------------------------------------------------
# GET /v1/conversations/{user_id}/{conversation_id}/sources
# ---------------------------------------------------------------------------
async def test_the_owner_gets_the_validated_sources(client, agents_service, session_factory, seeded_user,
                                                    seeded_agent):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent)
    path = _sources_path(seeded_user.id, conv_id)
    bad = {**GOOD, "id": "aaaaaa", "url": "javascript:alert(1)"}
    agents_service.on("GET", path, httpx.Response(200, json={"sources": [GOOD, bad, OTHER]}))

    resp = await client.get(f"/v1/conversations/{seeded_user.id}/{conv_id}/sources")

    assert resp.status_code == 200
    assert resp.json() == {"sources": [GOOD, OTHER]}
    [call] = agents_service.called("GET", path)
    # The internal-service credential rides every agents-service call.
    assert call.headers.get(settings.proxy.header_name)


@pytest.mark.parametrize("reply", [
    httpx.Response(503),
    httpx.Response(200, content=b"not json"),
    httpx.Response(200, json=["not", "an", "object"]),
    httpx.Response(200, json={"sources": "nope"}),
])
async def test_an_unhealthy_agents_service_is_an_empty_list(client, agents_service, session_factory, seeded_user,
                                                            seeded_agent, reply):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent)
    agents_service.on("GET", _sources_path(seeded_user.id, conv_id), reply)

    resp = await client.get(f"/v1/conversations/{seeded_user.id}/{conv_id}/sources")

    assert resp.status_code == 200 and resp.json() == {"sources": []}


async def test_an_unreachable_agents_service_is_an_empty_list(client, agents_service, session_factory, seeded_user,
                                                              seeded_agent):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent)

    def down(request):
        raise httpx.ConnectError("agents down", request=request)

    agents_service.on("GET", _sources_path(seeded_user.id, conv_id), down)

    resp = await client.get(f"/v1/conversations/{seeded_user.id}/{conv_id}/sources")

    assert resp.status_code == 200 and resp.json() == {"sources": []}


async def test_someone_elses_conversation_is_a_404_without_an_upstream_call(
    client, agents_service, session_factory, seeded_user, seeded_agent
):
    other = await _conversation(session_factory, "someone-else", seeded_agent)

    resp = await client.get(f"/v1/conversations/{seeded_user.id}/{other}/sources")

    assert resp.status_code == 404
    assert agents_service.calls == []


async def test_a_trial_conversation_is_a_404(client, agents_service, session_factory, seeded_user, seeded_agent):
    trial = await _conversation(session_factory, seeded_user.id, seeded_agent, is_trial=True)

    resp = await client.get(f"/v1/conversations/{seeded_user.id}/{trial}/sources")

    assert resp.status_code == 404
    assert agents_service.calls == []


async def test_no_session_is_a_401(app, client, session_factory, seeded_user, seeded_agent):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent)
    app.dependency_overrides.pop(validate_userId)

    resp = await client.get(f"/v1/conversations/{seeded_user.id}/{conv_id}/sources")

    assert resp.status_code == 401


async def test_another_users_path_is_a_403(app, client, session_factory, seeded_user, seeded_agent):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent)
    app.dependency_overrides.pop(validate_userId)

    async def signed_in_as_someone_else():
        return SimpleNamespace(id="someone-else")

    app.dependency_overrides[require_current_user] = signed_in_as_someone_else

    resp = await client.get(f"/v1/conversations/{seeded_user.id}/{conv_id}/sources")

    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Lifecycle: fork, delete
# ---------------------------------------------------------------------------
async def test_the_copy_posts_the_fork_target(client, agents_service):
    path = f"{_sources_path('u1', 'c-src')}/copy"
    agents_service.on("POST", path, httpx.Response(204))

    await copy_conversation_sources("u1", "c-src", "c-fork")

    [call] = agents_service.called("POST", path)
    assert json.loads(call.content) == {"target_conversation_id": "c-fork"}


async def test_a_failed_copy_never_fails_the_fork(client, agents_service):
    agents_service.on("POST", f"{_sources_path('u1', 'c-src')}/copy", httpx.Response(500))

    await copy_conversation_sources("u1", "c-src", "c-fork")  # logged, not raised


async def test_a_fork_copies_files_and_sources(client, agents_service, session_factory, seeded_user, seeded_agent):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent)
    async with session_factory() as s:
        ai_id = (await s.execute(
            select(MessageTable.id).where(MessageTable.conversation_id == conv_id, MessageTable.sender == "ai")
        )).scalar_one()
    base = f"/users/{seeded_user.id}/conversations/{conv_id}"
    agents_service.on("POST", f"{base}/files/copy", httpx.Response(204))
    agents_service.on("POST", f"{base}/sources/copy", httpx.Response(204))

    resp = await client.post(f"/v1/conversations/{seeded_user.id}/{conv_id}/fork", json={"messageId": ai_id})

    assert resp.status_code == 201
    [call] = agents_service.called("POST", f"{base}/sources/copy")
    assert json.loads(call.content) == {"target_conversation_id": resp.json()["id"]}


@pytest.fixture
def reap_routes(agents_service, session_factory, monkeypatch):
    """The reap's agents-service routes for one conversation; the sources
    DELETE answers ``status`` (a list, so a test can change it)."""
    monkeypatch.setattr(runtime_reaps, "SessionLocal", session_factory)
    status = [204]

    def setup(user_id: str, conversation_id: str) -> str:
        agents_service.on("POST", "/tasks/cancel-scope", httpx.Response(200, json={"cancelled": 0}))
        agents_service.on("POST", f"/users/{user_id}/conversations/{conversation_id}/reap", httpx.Response(204))
        path = _sources_path(user_id, conversation_id)
        agents_service.on("DELETE", path, lambda _request: httpx.Response(status[0]))
        return path

    return SimpleNamespace(setup=setup, status=status)


async def _outbox(session_factory):
    async with session_factory() as s:
        return list((await s.execute(select(PendingRuntimeReapTable))).scalars())


@pytest.mark.parametrize("status_code", [204, 404])
async def test_deleting_a_conversation_drops_its_sources(client, agents_service, reap_routes, session_factory,
                                                         seeded_user, seeded_agent, status_code):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent)
    path = reap_routes.setup(seeded_user.id, conv_id)
    # 404: an agents service without the sources route has nothing to drop.
    reap_routes.status[0] = status_code

    assert (await client.delete(f"/v1/conversations/{seeded_user.id}/{conv_id}")).status_code == 204

    assert len(agents_service.called("DELETE", path)) == 1
    assert await _outbox(session_factory) == []


async def test_a_failed_sources_delete_keeps_the_reap_for_a_retry(client, agents_service, reap_routes,
                                                                  session_factory, seeded_user, seeded_agent):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent)
    path = reap_routes.setup(seeded_user.id, conv_id)
    reap_routes.status[0] = 503

    assert (await client.delete(f"/v1/conversations/{seeded_user.id}/{conv_id}")).status_code == 204
    [row] = await _outbox(session_factory)
    assert row.conversation_id == conv_id and row.attempts == 1

    reap_routes.status[0] = 204
    assert await runtime_reaps.drain_runtime_reaps() == 1
    assert len(agents_service.called("DELETE", path)) == 2
    assert await _outbox(session_factory) == []


# ---------------------------------------------------------------------------
# Share: the cited sources are frozen into the snapshot
# ---------------------------------------------------------------------------
async def _ai_message_id(session_factory, conv_id: str) -> str:
    async with session_factory() as s:
        return (await s.execute(
            select(MessageTable.id).where(MessageTable.conversation_id == conv_id, MessageTable.sender == "ai")
        )).scalar_one()


async def test_a_share_freezes_only_the_cited_sources(client, agents_service, session_factory, seeded_user,
                                                      seeded_agent):
    content = "Growth was 12% [src:3fa2c1]. Ignore [src:zzz] and `code`."
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent, content=content)
    uncited = {**GOOD, "id": "abcdef", "title": "From another branch"}
    agents_service.on("GET", _sources_path(seeded_user.id, conv_id),
                      httpx.Response(200, json={"sources": [uncited, GOOD, OTHER]}))

    share = await client.post(f"/v1/conversations/{seeded_user.id}/{conv_id}/share",
                              json={"messageId": await _ai_message_id(session_factory, conv_id), "mode": "full"})
    assert share.status_code == 201
    public = await client.get(f"/v1/shared-conversations/{share.json()['token']}")

    assert public.status_code == 200
    assert public.json()["sources"] == [GOOD]


async def test_a_share_without_markers_asks_for_nothing(client, agents_service, session_factory, seeded_user,
                                                        seeded_agent):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent, content="No citations here.")

    share = await client.post(f"/v1/conversations/{seeded_user.id}/{conv_id}/share",
                              json={"messageId": await _ai_message_id(session_factory, conv_id), "mode": "full"})
    public = await client.get(f"/v1/shared-conversations/{share.json()['token']}")

    assert share.status_code == 201 and public.json()["sources"] == []
    assert agents_service.calls == []


async def test_a_share_still_works_when_the_agents_service_is_down(client, agents_service, session_factory,
                                                                   seeded_user, seeded_agent):
    conv_id = await _conversation(session_factory, seeded_user.id, seeded_agent, content="Cited [src:3fa2c1].")
    agents_service.on("GET", _sources_path(seeded_user.id, conv_id), httpx.Response(503))

    share = await client.post(f"/v1/conversations/{seeded_user.id}/{conv_id}/share",
                              json={"messageId": await _ai_message_id(session_factory, conv_id), "mode": "full"})

    assert share.status_code == 201
    assert (await client.get(f"/v1/shared-conversations/{share.json()['token']}")).json()["sources"] == []


# ---------------------------------------------------------------------------
# The live SOURCES event survives the event log
# ---------------------------------------------------------------------------
def test_the_sources_event_is_stored_unchanged_by_a_run():
    runtime = InferenceRunRuntime()
    events = [
        {"type": "TOOL_CALL_START", "toolCallId": "c1", "toolCallName": "tavily-search"},
        {"type": "TOOL_CALL_RESULT", "toolCallId": "c1", "content": "x" * 100_000},
        {"type": "TOOL_CALL_END", "toolCallId": "c1"},
        deepcopy(SOURCES_EVENT),
        deepcopy(SOURCES_EVENT),  # a second tool's sources: never merged with the first
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "Grew 12% "},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "[src:3fa2c1]."},
    ]
    wire = [runtime.apply_event(event) for event in events]

    stored = [e for e in runtime.raw_events if e.get("name") == "SOURCES"]
    assert len(stored) == 2
    for event in stored + [w for w in wire if w and w.get("name") == "SOURCES"]:
        assert {k: v for k, v in event.items() if k != "seq"} == SOURCES_EVENT
    # The text deltas around it still coalesce into one block, marker intact.
    assert runtime.raw_events[-1]["delta"] == "Grew 12% [src:3fa2c1]."
    # Persisted as JSON (messages.raw_events / the Redis stream): a round trip changes nothing.
    assert json.loads(json.dumps(runtime.raw_events)) == runtime.raw_events


def test_a_sub_agents_sources_event_survives_its_envelope():
    runtime = InferenceRunRuntime()
    wrapped = {"type": "CUSTOM", "name": "SUBAGENT_EVENT",
               "value": {"task_id": "t1", "event": deepcopy(SOURCES_EVENT)}}
    runtime.apply_event(deepcopy(wrapped))
    runtime.apply_event(deepcopy(wrapped))

    assert [{k: v for k, v in e.items() if k != "seq"} for e in runtime.raw_events] == [wrapped, wrapped]


def test_the_coalescer_and_truncation_leave_it_alone():
    log: list[dict] = []
    append_coalesced(log, SOURCES_EVENT)
    append_coalesced(log, SOURCES_EVENT)
    assert log == [SOURCES_EVENT, SOURCES_EVENT] and log[0] is not SOURCES_EVENT
    assert truncate_tool_result(SOURCES_EVENT) is SOURCES_EVENT


async def test_a_background_tasks_captured_log_keeps_it():
    await task_streams._client.xadd(task_events_key("task-src"), {"data": json.dumps(SOURCES_EVENT)})

    captured = await async_tasks.capture_task_events("task-src")

    assert captured == [{**SOURCES_EVENT, "seq": 1}]
