"""The bridge's routes over a conversation's sources (plan 42 §3.7).

Pinned: the read returns ``{"sources": [{id, url, title, snippet, tool}]}``; a
fork's copy and a delete answer 204; everything is internal-only (403 without
the service secret, before the store is touched).
"""
from __future__ import annotations

import importlib

import pytest

pytestmark = pytest.mark.asyncio

SOURCES = "/users/u1/conversations/c1/sources"


class _Store:
    def __init__(self, listed):
        self.listed = listed
        self.calls: list[tuple] = []

    async def list_sources(self, user_id, conversation_id):
        self.calls.append(("list", user_id, conversation_id))
        return self.listed

    async def copy_conversation(self, user_id, source_id, target_id):
        self.calls.append(("copy", user_id, source_id, target_id))
        return 1

    async def delete_conversation(self, user_id, conversation_id):
        self.calls.append(("delete", user_id, conversation_id))
        return 1


@pytest.fixture
def store(agents_service, monkeypatch):
    sources = importlib.import_module("harness.sources")
    url = "https://example.com/report"
    fake = _Store([sources.Source(id=sources.source_id(url), url=url, title="Report", snippet="s", tool="tavily-search")])
    monkeypatch.setattr(importlib.import_module("utils.conversation_sources"), "_store", lambda: fake)
    return fake


async def test_the_read_returns_the_contract_shape(client, internal_headers, store):
    response = await client.get(SOURCES, headers=internal_headers)

    assert response.status_code == 200
    [item] = response.json()["sources"]
    assert item == {"id": store.listed[0].id, "url": "https://example.com/report", "title": "Report",
                    "snippet": "s", "tool": "tavily-search"}
    assert store.calls == [("list", "u1", "c1")]


async def test_a_fork_copy_and_a_delete_answer_204(client, internal_headers, store):
    copied = await client.post(f"{SOURCES}/copy", json={"target_conversation_id": "fork"}, headers=internal_headers)
    deleted = await client.delete(SOURCES, headers=internal_headers)

    assert copied.status_code == 204 and deleted.status_code == 204
    assert store.calls == [("copy", "u1", "c1", "fork"), ("delete", "u1", "c1")]


async def test_a_copy_needs_a_target(client, internal_headers, store):
    response = await client.post(f"{SOURCES}/copy", json={"target_conversation_id": ""}, headers=internal_headers)
    assert response.status_code == 422 and store.calls == []


async def test_every_route_refuses_a_caller_without_the_internal_secret(client, store):
    assert (await client.get(SOURCES)).status_code == 403
    assert (await client.post(f"{SOURCES}/copy", json={"target_conversation_id": "fork"})).status_code == 403
    assert (await client.delete(SOURCES)).status_code == 403
    assert store.calls == []
