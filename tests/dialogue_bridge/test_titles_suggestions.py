"""Unit tests for ``utils.titles`` and ``utils.suggestions``.

Both modules post to the agents service through an ``httpx.AsyncClient`` opened
inside the function, so we monkeypatch ``<module>.httpx.AsyncClient`` with a
fake client that returns a controlled JSON response (or raises an httpx error).
Titles selection is randomized, so the few tests that assert a specific picked
title pin ``random.randrange`` to a fixed index.
"""
from __future__ import annotations

import httpx
import pytest

import utils.titles as titles_mod
import utils.suggestions as suggestions_mod
from schemas import AttachmentIn, MessageIn
from utils.suggestions import (
    build_suggestion_context_payload,
    generate_conversation_suggestions,
)
from utils.titles import (
    _message_to_chain_payload,
    generate_conversation_title,
    resolve_conversation_title,
)


# ---------------------------------------------------------------------------
# Fake httpx plumbing
# ---------------------------------------------------------------------------
class FakeResponse:
    def __init__(self, *, status_code: int = 200, json_data=None, raise_status: bool = False):
        self.status_code = status_code
        self._json_data = json_data
        self._raise_status = raise_status

    def json(self):
        if isinstance(self._json_data, Exception):
            raise self._json_data
        return self._json_data

    def raise_for_status(self):
        if self._raise_status or self.status_code >= 400:
            request = httpx.Request("POST", "http://agents.test/x")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("boom", request=request, response=response)


class FakeClient:
    def __init__(self, handler):
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kwargs):
        result = self._handler(url, kwargs)
        if isinstance(result, Exception):
            raise result
        return result


def install_fake_client(module, monkeypatch, handler):
    def factory(*args, **kwargs):
        return FakeClient(handler)

    monkeypatch.setattr(module.httpx, "AsyncClient", factory)


def _text_message(content: str | None = "Hello world") -> MessageIn:
    return MessageIn(sender="user", type="text", content=content)


# ---------------------------------------------------------------------------
# titles._message_to_chain_payload
# ---------------------------------------------------------------------------
def test_message_to_chain_payload_plain_text():
    payload = _message_to_chain_payload(_text_message("  Hi there  "))
    assert payload == [{"role": "user", "content": "Hi there"}]


def test_message_to_chain_payload_with_image_attachment():
    img = AttachmentIn(name="pic.png", mime="image/png", dataB64="aGVsbG8=")
    message = MessageIn(sender="user", type="image", content="Look", attachments=[img])
    payload = _message_to_chain_payload(message)
    content = payload[0]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "Look"}
    image_part = next(part for part in content if part["type"] == "image_url")
    assert image_part["image_url"]["url"].startswith("data:image/png;base64,")


def test_message_to_chain_payload_with_non_image_attachment_lists_names():
    doc = AttachmentIn(name="report.pdf", mime="application/pdf", dataB64="aGVsbG8=")
    message = MessageIn(sender="user", type="file", content="See doc", attachments=[doc])
    payload = _message_to_chain_payload(message)
    content = payload[0]["content"]
    # text + the attachments summary block
    joined = " ".join(part["text"] for part in content if part["type"] == "text")
    assert "Attachments included:" in joined
    assert "report.pdf" in joined


def test_message_to_chain_payload_empty_content_defaults_to_empty_text():
    message = MessageIn(sender="ai", type="text", content=None)
    payload = _message_to_chain_payload(message)
    assert payload == [{"role": "user", "content": ""}]


# ---------------------------------------------------------------------------
# titles.generate_conversation_title
# ---------------------------------------------------------------------------
async def test_generate_title_picks_from_candidates(monkeypatch):
    install_fake_client(
        titles_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"titles": ["Alpha", "Beta", "Gamma"]}),
    )
    monkeypatch.setattr(titles_mod.random, "randrange", lambda n: 1)
    title = await generate_conversation_title(_text_message())
    assert title == "Beta"


async def test_generate_title_dedupes_and_truncates(monkeypatch):
    long_title = "x" * 200
    install_fake_client(
        titles_mod,
        monkeypatch,
        lambda url, k: FakeResponse(
            json_data={"titles": ["Same", "same", "Other", long_title]}
        ),
    )
    monkeypatch.setattr(titles_mod.random, "randrange", lambda n: n - 1)
    title = await generate_conversation_title(_text_message())
    # "Same"/"same" collapse to one, so the candidates are [Same, Other, <trunc>]
    assert len(title) == titles_mod._TITLE_MAX_LEN


async def test_generate_title_insufficient_candidates_returns_none(monkeypatch):
    install_fake_client(
        titles_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"titles": ["only-one"]}),
    )
    assert await generate_conversation_title(_text_message()) is None


async def test_generate_title_http_error_returns_none(monkeypatch):
    install_fake_client(
        titles_mod,
        monkeypatch,
        lambda url, k: FakeResponse(status_code=500, raise_status=True),
    )
    assert await generate_conversation_title(_text_message()) is None


async def test_generate_title_request_error_returns_none(monkeypatch):
    install_fake_client(
        titles_mod,
        monkeypatch,
        lambda url, k: httpx.ConnectError("down", request=httpx.Request("POST", "http://agents.test")),
    )
    assert await generate_conversation_title(_text_message()) is None


async def test_generate_title_invalid_payload_returns_none(monkeypatch):
    install_fake_client(
        titles_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"unexpected": "shape"}),
    )
    assert await generate_conversation_title(_text_message()) is None


# ---------------------------------------------------------------------------
# titles.resolve_conversation_title
# ---------------------------------------------------------------------------
async def test_resolve_title_uses_explicit_title():
    title = await resolve_conversation_title(_text_message(), "  My Title  ", "Agent", "a1")
    assert title == "My Title"


async def test_resolve_title_uses_generated_when_no_explicit(monkeypatch):
    async def fake_generate(message):
        return "Generated Title"

    monkeypatch.setattr(titles_mod, "generate_conversation_title", fake_generate)
    title = await resolve_conversation_title(_text_message(), None, "Agent", "a1")
    assert title == "Generated Title"


async def test_resolve_title_falls_back_to_preview(monkeypatch):
    async def fake_generate(message):
        return None

    monkeypatch.setattr(titles_mod, "generate_conversation_title", fake_generate)
    title = await resolve_conversation_title(
        _text_message("This is the opening user message"), None, "Agent", "a1"
    )
    assert title  # the _preview of the content
    assert title != "Agent"


async def test_resolve_title_falls_back_to_agent_name(monkeypatch):
    async def fake_generate(message):
        return None

    monkeypatch.setattr(titles_mod, "generate_conversation_title", fake_generate)
    # Empty content -> no preview -> agent name fallback
    empty = MessageIn(sender="ai", type="text", content=None)
    title = await resolve_conversation_title(empty, None, "My Agent", "a1")
    assert title == "My Agent"


async def test_resolve_title_falls_back_to_default(monkeypatch):
    async def fake_generate(message):
        return None

    monkeypatch.setattr(titles_mod, "generate_conversation_title", fake_generate)
    empty = MessageIn(sender="ai", type="text", content=None)
    title = await resolve_conversation_title(empty, None, None, None)
    assert title == "New conversation"


# ---------------------------------------------------------------------------
# suggestions.build_suggestion_context_payload
# ---------------------------------------------------------------------------
def test_build_suggestion_context_with_agent_and_history():
    payload = build_suggestion_context_payload(
        agent_name="Researcher",
        agent_description="Finds papers",
        recent_conversations=[
            {"title": "Quantum chat", "last_message": "What is entanglement?", "agent_name": "Researcher"},
            {"title": "", "last_message": "", "agent_name": ""},
        ],
    )
    content = payload[0]["content"]
    assert "Selected agent: Researcher" in content
    assert "Selected agent description: Finds papers" in content
    assert "Recent conversation context:" in content
    assert "Quantum chat" in content
    assert "agent=Researcher" in content
    assert "last_message=What is entanglement?" in content
    # second conversation with empty title falls back to "Untitled conversation"
    assert "Untitled conversation" in content


def test_build_suggestion_context_without_history():
    payload = build_suggestion_context_payload(
        agent_name=None, agent_description=None, recent_conversations=[]
    )
    content = payload[0]["content"]
    assert "No recent conversation context is available" in content
    assert "Selected agent:" not in content


# ---------------------------------------------------------------------------
# suggestions.generate_conversation_suggestions
# ---------------------------------------------------------------------------
def _six_suggestions():
    return [f"Suggestion number {i}" for i in range(6)]


async def test_generate_suggestions_success(monkeypatch):
    install_fake_client(
        suggestions_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"suggestions": _six_suggestions()}),
    )
    result = await generate_conversation_suggestions(
        agent_name="A", agent_description="d", recent_conversations=[]
    )
    assert result == _six_suggestions()


async def test_generate_suggestions_dedupes_and_truncates_and_caps_at_10(monkeypatch):
    long = "y" * 200
    raw = [f"unique-{i}" for i in range(12)] + ["dup", "dup", long]
    install_fake_client(
        suggestions_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"suggestions": raw}),
    )
    result = await generate_conversation_suggestions(
        agent_name=None, agent_description=None, recent_conversations=[]
    )
    assert len(result) == 10
    assert len(set(result)) == 10


async def test_generate_suggestions_insufficient_returns_empty(monkeypatch):
    install_fake_client(
        suggestions_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"suggestions": ["a", "b", "c"]}),
    )
    result = await generate_conversation_suggestions(
        agent_name=None, agent_description=None, recent_conversations=[]
    )
    assert result == []


async def test_generate_suggestions_http_error_returns_empty(monkeypatch):
    install_fake_client(
        suggestions_mod,
        monkeypatch,
        lambda url, k: FakeResponse(status_code=502, raise_status=True),
    )
    result = await generate_conversation_suggestions(
        agent_name=None, agent_description=None, recent_conversations=[]
    )
    assert result == []


async def test_generate_suggestions_request_error_returns_empty(monkeypatch):
    install_fake_client(
        suggestions_mod,
        monkeypatch,
        lambda url, k: httpx.ConnectTimeout("t", request=httpx.Request("POST", "http://agents.test")),
    )
    result = await generate_conversation_suggestions(
        agent_name=None, agent_description=None, recent_conversations=[]
    )
    assert result == []


async def test_generate_suggestions_invalid_payload_returns_empty(monkeypatch):
    install_fake_client(
        suggestions_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"not_suggestions": []}),
    )
    result = await generate_conversation_suggestions(
        agent_name=None, agent_description=None, recent_conversations=[]
    )
    assert result == []
