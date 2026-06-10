"""Unit tests for ``utils.voice`` and ``utils.speech``.

Voice splits into pure helpers (normalization, instruction building) and
httpx/DB-backed helpers. The pure helpers are tested directly; the DB ones use
the ``session_factory`` + ``seeded_*`` fixtures; the httpx one
(``create_realtime_session_with_agents``) and the two speech proxies are tested
by monkeypatching ``<module>.httpx.AsyncClient`` with a fake client.
"""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

import utils.speech as speech_mod
import utils.voice as voice_mod
from core.database import AgentTable, UserPreferencesTable
from schemas import DictationResponse
from utils.speech import (
    generate_read_aloud_audio,
    read_aloud_response,
    transcribe_dictation_audio,
)
from utils.voice import (
    build_voice_instructions,
    create_realtime_session_with_agents,
    load_realtime_agent,
    normalize_realtime_voice,
    normalize_voice_mode_language,
    preferred_realtime_voice,
    preferred_voice_mode_language,
    recent_history_for_voice_instructions,
)


# ---------------------------------------------------------------------------
# Fake httpx plumbing (response carries .json(), .content, .headers)
# ---------------------------------------------------------------------------
class FakeResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        json_data=None,
        content: bytes = b"",
        headers: dict | None = None,
        raise_status: bool = False,
    ):
        self.status_code = status_code
        self._json_data = json_data
        self.content = content
        self.headers = headers or {}
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


# ---------------------------------------------------------------------------
# voice.normalize_realtime_voice / normalize_voice_mode_language
# ---------------------------------------------------------------------------
def test_normalize_realtime_voice_supported_passthrough():
    assert normalize_realtime_voice("Nova") == "nova"


def test_normalize_realtime_voice_unsupported_falls_back_to_default():
    assert normalize_realtime_voice("does-not-exist") == "alloy"


def test_normalize_realtime_voice_none_falls_back_to_default():
    assert normalize_realtime_voice(None) == "alloy"


def test_normalize_voice_mode_language_greek():
    assert normalize_voice_mode_language("Greek") == "greek"


def test_normalize_voice_mode_language_unknown_defaults_english():
    assert normalize_voice_mode_language("french") == "english"
    assert normalize_voice_mode_language(None) == "english"


# ---------------------------------------------------------------------------
# voice.recent_history_for_voice_instructions / build_voice_instructions
# ---------------------------------------------------------------------------
def test_recent_history_formats_user_and_assistant_lines():
    conversation = SimpleNamespace(
        messages=[
            SimpleNamespace(sender="user", content="Hello"),
            SimpleNamespace(sender="ai", content="Hi, how can I help?"),
            SimpleNamespace(sender="user", content="   "),  # blank skipped
        ]
    )
    history = recent_history_for_voice_instructions(conversation)
    assert "User: Hello" in history
    assert "Assistant: Hi, how can I help?" in history
    # the blank message is dropped
    assert history.count("\n") == 1


def test_recent_history_empty_when_no_messages():
    conversation = SimpleNamespace(messages=[])
    assert recent_history_for_voice_instructions(conversation) == ""


def test_build_voice_instructions_english_no_history():
    agent = SimpleNamespace(name="Aria", description="A helpful agent")
    text = build_voice_instructions(agent, conversation=None, language="english")
    assert "You are Aria." in text
    assert "A helpful agent" in text
    assert "Use English as the default language" in text
    assert "Recent conversation context:" not in text


def test_build_voice_instructions_greek_with_history():
    agent = SimpleNamespace(name="Aria", description="A helpful agent")
    conversation = SimpleNamespace(messages=[SimpleNamespace(sender="user", content="Hi")])
    text = build_voice_instructions(agent, conversation=conversation, language="greek")
    assert "Use Greek as the default language" in text
    assert "Recent conversation context:" in text
    assert "User: Hi" in text


# ---------------------------------------------------------------------------
# voice.load_realtime_agent (DB)
# ---------------------------------------------------------------------------
async def test_load_realtime_agent_returns_active(session_factory, seeded_agent):
    async with session_factory() as session:
        agent = await load_realtime_agent(session, seeded_agent.id)
        assert agent.id == seeded_agent.id


async def test_load_realtime_agent_unknown_raises_400(session_factory):
    async with session_factory() as session:
        with pytest.raises(Exception) as exc:
            await load_realtime_agent(session, "no-such-agent")
        assert getattr(exc.value, "status_code", None) == 400


async def test_load_realtime_agent_inactive_raises_400(session_factory):
    async with session_factory() as session:
        inactive = AgentTable(
            slug="inactive-agent",
            name="Inactive",
            description="off",
            icon="bot",
            is_active=False,
        )
        session.add(inactive)
        await session.commit()
        await session.refresh(inactive)
        with pytest.raises(Exception) as exc:
            await load_realtime_agent(session, inactive.id)
        assert getattr(exc.value, "status_code", None) == 400


# ---------------------------------------------------------------------------
# voice.preferred_realtime_voice / preferred_voice_mode_language (DB)
# ---------------------------------------------------------------------------
async def test_preferred_realtime_voice_uses_requested(session_factory, seeded_user):
    async with session_factory() as session:
        voice = await preferred_realtime_voice(session, seeded_user.id, "Coral")
        assert voice == "coral"


async def test_preferred_realtime_voice_reads_preferences(session_factory, seeded_user):
    async with session_factory() as session:
        session.add(
            UserPreferencesTable(
                user_id=seeded_user.id,
                tools={"disabled": []},
                voice_mode_voice="sage",
                voice_mode_language="english",
            )
        )
        await session.commit()
    async with session_factory() as session:
        voice = await preferred_realtime_voice(session, seeded_user.id, None)
        assert voice == "sage"


async def test_preferred_realtime_voice_defaults_when_no_preferences(session_factory, seeded_user):
    async with session_factory() as session:
        voice = await preferred_realtime_voice(session, seeded_user.id, None)
        assert voice == "alloy"


async def test_preferred_voice_mode_language_uses_requested(session_factory, seeded_user):
    async with session_factory() as session:
        lang = await preferred_voice_mode_language(session, seeded_user.id, "greek")
        assert lang == "greek"


async def test_preferred_voice_mode_language_reads_preferences(session_factory, seeded_user):
    async with session_factory() as session:
        session.add(
            UserPreferencesTable(
                user_id=seeded_user.id,
                tools={"disabled": []},
                voice_mode_voice="alloy",
                voice_mode_language="greek",
            )
        )
        await session.commit()
    async with session_factory() as session:
        lang = await preferred_voice_mode_language(session, seeded_user.id, None)
        assert lang == "greek"


async def test_preferred_voice_mode_language_defaults_when_no_preferences(session_factory, seeded_user):
    async with session_factory() as session:
        lang = await preferred_voice_mode_language(session, seeded_user.id, None)
        assert lang == "english"


# ---------------------------------------------------------------------------
# voice.create_realtime_session_with_agents (httpx)
# ---------------------------------------------------------------------------
async def test_create_realtime_session_returns_payload(monkeypatch):
    install_fake_client(
        voice_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"sdp": "answer", "model": "m", "voice": "v"}),
    )
    data = await create_realtime_session_with_agents(
        sdp="offer", model="m", voice="v", instructions="i", metadata={}
    )
    assert data["sdp"] == "answer"


async def test_create_realtime_session_http_error_502(monkeypatch):
    install_fake_client(
        voice_mod,
        monkeypatch,
        lambda url, k: FakeResponse(status_code=500, raise_status=True),
    )
    with pytest.raises(Exception) as exc:
        await create_realtime_session_with_agents(
            sdp="o", model="m", voice="v", instructions="i", metadata={}
        )
    assert getattr(exc.value, "status_code", None) == 502


async def test_create_realtime_session_request_error_503(monkeypatch):
    install_fake_client(
        voice_mod,
        monkeypatch,
        lambda url, k: httpx.ConnectError("x", request=httpx.Request("POST", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await create_realtime_session_with_agents(
            sdp="o", model="m", voice="v", instructions="i", metadata={}
        )
    assert getattr(exc.value, "status_code", None) == 503


async def test_create_realtime_session_invalid_json_502(monkeypatch):
    install_fake_client(
        voice_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data=ValueError("no json")),
    )
    with pytest.raises(Exception) as exc:
        await create_realtime_session_with_agents(
            sdp="o", model="m", voice="v", instructions="i", metadata={}
        )
    assert getattr(exc.value, "status_code", None) == 502


async def test_create_realtime_session_missing_sdp_field_502(monkeypatch):
    install_fake_client(
        voice_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"model": "m"}),  # no "sdp"
    )
    with pytest.raises(Exception) as exc:
        await create_realtime_session_with_agents(
            sdp="o", model="m", voice="v", instructions="i", metadata={}
        )
    assert getattr(exc.value, "status_code", None) == 502


# ---------------------------------------------------------------------------
# speech.read_aloud_response
# ---------------------------------------------------------------------------
async def test_read_aloud_response_streams_with_headers():
    response = read_aloud_response(b"audio-bytes", "audio/mpeg", "out.mp3")
    assert response.media_type == "audio/mpeg"
    assert response.headers["content-disposition"] == 'inline; filename="out.mp3"'
    assert response.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# speech.transcribe_dictation_audio (httpx)
# ---------------------------------------------------------------------------
async def test_transcribe_dictation_empty_audio_400():
    with pytest.raises(Exception) as exc:
        await transcribe_dictation_audio(b"", filename="x.wav", content_type="audio/wav")
    assert getattr(exc.value, "status_code", None) == 400


async def test_transcribe_dictation_success(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"text": "transcribed"}),
    )
    result = await transcribe_dictation_audio(b"wave", filename="x.wav", content_type="audio/wav")
    assert isinstance(result, DictationResponse)
    assert result.text == "transcribed"


async def test_transcribe_dictation_http_error_502(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: FakeResponse(status_code=500, raise_status=True),
    )
    with pytest.raises(Exception) as exc:
        await transcribe_dictation_audio(b"wave", filename="x.wav", content_type="audio/wav")
    assert getattr(exc.value, "status_code", None) == 502


async def test_transcribe_dictation_request_error_503(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: httpx.ConnectError("x", request=httpx.Request("POST", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await transcribe_dictation_audio(b"wave", filename="x.wav", content_type="audio/wav")
    assert getattr(exc.value, "status_code", None) == 503


async def test_transcribe_dictation_invalid_json_502(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data=ValueError("bad")),
    )
    with pytest.raises(Exception) as exc:
        await transcribe_dictation_audio(b"wave", filename="x.wav", content_type="audio/wav")
    assert getattr(exc.value, "status_code", None) == 502


async def test_transcribe_dictation_invalid_payload_502(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: FakeResponse(json_data={"no_text": True}),
    )
    with pytest.raises(Exception) as exc:
        await transcribe_dictation_audio(b"wave", filename="x.wav", content_type="audio/wav")
    assert getattr(exc.value, "status_code", None) == 502


# ---------------------------------------------------------------------------
# speech.generate_read_aloud_audio (httpx)
# ---------------------------------------------------------------------------
async def test_generate_read_aloud_empty_text_400():
    with pytest.raises(Exception) as exc:
        await generate_read_aloud_audio("   ", voice="nova")
    assert getattr(exc.value, "status_code", None) == 400


async def test_generate_read_aloud_too_long_413():
    from utils.speech import MAX_READ_ALOUD_TEXT_CHARS

    with pytest.raises(Exception) as exc:
        await generate_read_aloud_audio("x" * (MAX_READ_ALOUD_TEXT_CHARS + 1), voice="nova")
    assert getattr(exc.value, "status_code", None) == 413


async def test_generate_read_aloud_success(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: FakeResponse(content=b"mp3-bytes", headers={"content-type": "audio/mpeg; charset=x"}),
    )
    audio, content_type = await generate_read_aloud_audio("Hello", voice="nova")
    assert audio == b"mp3-bytes"
    assert content_type == "audio/mpeg"


async def test_generate_read_aloud_defaults_content_type(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: FakeResponse(content=b"x", headers={}),
    )
    audio, content_type = await generate_read_aloud_audio("Hello", voice=None)
    assert content_type == "audio/mpeg"


async def test_generate_read_aloud_empty_audio_502(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: FakeResponse(content=b"", headers={}),
    )
    with pytest.raises(Exception) as exc:
        await generate_read_aloud_audio("Hello", voice="nova")
    assert getattr(exc.value, "status_code", None) == 502


async def test_generate_read_aloud_http_error_502(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: FakeResponse(status_code=500, raise_status=True),
    )
    with pytest.raises(Exception) as exc:
        await generate_read_aloud_audio("Hello", voice="nova")
    assert getattr(exc.value, "status_code", None) == 502


async def test_generate_read_aloud_request_error_503(monkeypatch):
    install_fake_client(
        speech_mod,
        monkeypatch,
        lambda url, k: httpx.ConnectError("x", request=httpx.Request("POST", "http://agents.test")),
    )
    with pytest.raises(Exception) as exc:
        await generate_read_aloud_audio("Hello", voice="nova")
    assert getattr(exc.value, "status_code", None) == 503
