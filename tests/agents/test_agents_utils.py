from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
class _FakeTool:
    """Duck-typed stand-in for mcp.types.Tool used by the manifest helpers."""

    def __init__(self, name=None, description=None, inputSchema=None, annotations=None):
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
        self.annotations = annotations


class _FakeAnnotations:
    def __init__(self, dump):
        self._dump = dump

    def model_dump(self):
        return self._dump


class _UnstringifiableName:
    def __str__(self):
        raise RuntimeError("cannot stringify")


def _make_tool(agents_service, **kwargs):
    """Build a real mcp.types.Tool when possible, else a duck-typed fallback."""
    types = agents_service.mcp_tools.types
    return types.Tool(**kwargs)


class _FakeAsyncChain:
    def __init__(self, *, result=None, error=None):
        self._result = result
        self._error = error

    async def ainvoke(self, _user_input):
        if self._error is not None:
            raise self._error
        return self._result


# ===========================================================================
# mcp_tools.py
# ===========================================================================
def test_map_server_id_returns_existing_server(agents_service):
    m = agents_service.mcp_tools
    assert m._map_server_id("already", "tavily-search") == "already"


def test_map_server_id_infers_from_override(agents_service):
    m = agents_service.mcp_tools
    assert m._map_server_id("", "tavily-search") == "tavily"
    assert m._map_server_id("", "SEARCH_PAPERS".lower()) == "arxiv"


def test_map_server_id_unknown_tool_stays_empty(agents_service):
    m = agents_service.mcp_tools
    assert m._map_server_id("", "unknown-tool") == ""


def test_make_cache_key_with_and_without_server(agents_service):
    m = agents_service.mcp_tools
    assert m._make_cache_key("tavily", "tavily-search") == "tavily/tavily-search"
    assert m._make_cache_key("", "loose-tool") == "loose-tool"
    assert m._make_cache_key("  ", "  bare  ") == "bare"


def test_build_cache_key_from_tool_name(agents_service):
    m = agents_service.mcp_tools
    assert m.build_cache_key_from_tool_name("tavily-search") == "tavily/tavily-search"
    assert m.build_cache_key_from_tool_name("plain") == "plain"
    assert m.build_cache_key_from_tool_name("") == ""


def test_build_tool_cache_key_public(agents_service):
    m = agents_service.mcp_tools
    assert m.build_tool_cache_key("arxiv", "read_paper") == "arxiv/read_paper"


def test_extract_tool_identity_overrides_server(agents_service):
    m = agents_service.mcp_tools
    server_id, tool_name = m._extract_tool_identity(_FakeTool(name="download_paper"))
    assert server_id == "arxiv"
    assert tool_name == "download_paper"


def test_extract_tool_identity_coerces_non_string_name(agents_service):
    m = agents_service.mcp_tools
    server_id, tool_name = m._extract_tool_identity(_FakeTool(name=12345))
    assert tool_name == "12345"
    assert server_id == ""


def test_extract_tool_identity_unstringifiable_name(agents_service):
    m = agents_service.mcp_tools
    server_id, tool_name = m._extract_tool_identity(_FakeTool(name=_UnstringifiableName()))
    assert tool_name == ""
    assert server_id == ""


def test_get_tool_cache_key_from_tool(agents_service):
    m = agents_service.mcp_tools
    key = m.get_tool_cache_key(_FakeTool(name="tavily-map"))
    assert key == "tavily/tavily-map"


def test_build_manifest_uses_schema_properties(agents_service):
    m = agents_service.mcp_tools
    tool = _make_tool(
        agents_service,
        name="tavily-search",
        description="Search the web",
        inputSchema={"type": "object", "properties": {"q": {}, "k": {}}},
    )
    manifest = m._build_manifest(tool)
    assert manifest.server_id == "tavily"
    assert manifest.tool_name == "tavily-search"
    assert manifest.description == "Search the web"
    assert manifest.parameter_count == 2


def test_build_manifest_falls_back_to_annotation_properties(agents_service):
    m = agents_service.mcp_tools
    tool = _FakeTool(
        name="custom_tool",
        description=None,
        inputSchema={},
        annotations=_FakeAnnotations({"title": "Custom Title", "properties": {"a": {}, "b": {}, "c": {}}}),
    )
    manifest = m._build_manifest(tool)
    assert manifest.parameter_count == 3
    assert manifest.description == "Custom Title"


def test_build_manifest_zero_parameters_and_empty_description(agents_service):
    m = agents_service.mcp_tools
    tool = _FakeTool(name="bare_tool", description=None, inputSchema=None, annotations=None)
    manifest = m._build_manifest(tool)
    assert manifest.parameter_count == 0
    assert manifest.description == ""
    assert manifest.tool_name == "bare_tool"


def test_prime_and_get_cached_manifests(agents_service, monkeypatch):
    m = agents_service.mcp_tools
    monkeypatch.setattr(m, "_MCP_TOOL_MANIFEST_CACHE", {})
    tools = [
        _make_tool(agents_service, name="tavily-search", description="s", inputSchema={"properties": {"q": {}}}),
        _make_tool(agents_service, name="tavily-map", description="m", inputSchema={"properties": {}}),
        _make_tool(agents_service, name="tavily-search", description="dup", inputSchema={"properties": {"q": {}}}),
        _FakeTool(name="", inputSchema={}),
    ]
    m._prime_manifest_cache(tools)

    manifests = m.get_cached_tool_manifests()
    mapping = m.get_cached_tool_manifests_map()
    keys = list(mapping.keys())

    assert keys == ["tavily/tavily-map", "tavily/tavily-search"]
    assert len(manifests) == 2
    assert all(item.server_id == "tavily" for item in manifests)


async def test_fetch_tools_from_gateway_success(agents_service, monkeypatch):
    m = agents_service.mcp_tools

    sample_tools = [_make_tool(agents_service, name="tavily-search", inputSchema={})]

    class _FakeSession:
        async def initialize(self):
            return None

        async def list_tools(self):
            return SimpleNamespace(tools=sample_tools)

    @asynccontextmanager
    async def fake_sse_client(url):
        assert url
        yield ("read", "write")

    @asynccontextmanager
    async def fake_client_session(read_stream, write_stream):
        assert (read_stream, write_stream) == ("read", "write")
        yield _FakeSession()

    monkeypatch.setattr(m, "sse_client", fake_sse_client)
    monkeypatch.setattr(m, "mcp", SimpleNamespace(ClientSession=fake_client_session))

    tools = await m._fetch_tools_from_gateway()
    assert tools == sample_tools


async def test_fetch_tools_from_gateway_unconfigured(agents_service, monkeypatch):
    m = agents_service.mcp_tools
    monkeypatch.setattr(m.settings.mcp, "mcp_gateway_url", "")
    with pytest.raises(m.MCPToolsClientError, match="not configured"):
        await m._fetch_tools_from_gateway()


async def test_fetch_tools_from_gateway_wraps_errors(agents_service, monkeypatch):
    m = agents_service.mcp_tools

    @asynccontextmanager
    async def boom_sse_client(url):
        raise RuntimeError("gateway down")
        yield  # pragma: no cover

    monkeypatch.setattr(m, "sse_client", boom_sse_client)
    with pytest.raises(m.MCPToolsClientError, match="Failed to list tools"):
        await m._fetch_tools_from_gateway()


async def test_list_mcp_tools_cache_hit_returns_empty(agents_service, monkeypatch):
    m = agents_service.mcp_tools
    monkeypatch.setattr(m.settings.mcp, "manifest_cache_enabled", True)
    monkeypatch.setattr(m, "_MCP_TOOL_MANIFEST_CACHE", {"tavily/tavily-search": object()})

    async def _should_not_fetch():
        raise AssertionError("gateway should not be called on cache hit")

    monkeypatch.setattr(m, "_fetch_tools_from_gateway", _should_not_fetch)
    result = await m.list_mcp_tools()
    assert result == []


async def test_list_mcp_tools_refreshes_cache_on_miss(agents_service, monkeypatch):
    m = agents_service.mcp_tools
    monkeypatch.setattr(m.settings.mcp, "manifest_cache_enabled", True)
    monkeypatch.setattr(m, "_MCP_TOOL_MANIFEST_CACHE", {})

    fetched = [_make_tool(agents_service, name="tavily-search", inputSchema={"properties": {"q": {}}})]

    async def fake_fetch():
        return fetched

    monkeypatch.setattr(m, "_fetch_tools_from_gateway", fake_fetch)
    result = await m.list_mcp_tools()
    assert result == fetched
    assert "tavily/tavily-search" in m.get_cached_tool_manifests_map()


async def test_list_mcp_tools_force_refresh_bypasses_cache(agents_service, monkeypatch):
    m = agents_service.mcp_tools
    monkeypatch.setattr(m.settings.mcp, "manifest_cache_enabled", True)
    monkeypatch.setattr(m, "_MCP_TOOL_MANIFEST_CACHE", {"stale": object()})

    fetched = [_make_tool(agents_service, name="tavily-map", inputSchema={})]
    called = {"n": 0}

    async def fake_fetch():
        called["n"] += 1
        return fetched

    monkeypatch.setattr(m, "_fetch_tools_from_gateway", fake_fetch)
    result = await m.list_mcp_tools(force_refresh=True)
    assert result == fetched
    assert called["n"] == 1


async def test_list_mcp_tools_cache_disabled_skips_priming(agents_service, monkeypatch):
    m = agents_service.mcp_tools
    monkeypatch.setattr(m.settings.mcp, "manifest_cache_enabled", False)
    monkeypatch.setattr(m, "_MCP_TOOL_MANIFEST_CACHE", {})

    fetched = [_make_tool(agents_service, name="tavily-map", inputSchema={})]

    async def fake_fetch():
        return fetched

    monkeypatch.setattr(m, "_fetch_tools_from_gateway", fake_fetch)
    result = await m.list_mcp_tools()
    assert result == fetched
    assert m.get_cached_tool_manifests_map() == {}


async def test_mcp_session_context_yields_initialized_session(agents_service, monkeypatch):
    m = agents_service.mcp_tools

    initialized = {"called": False}

    class _FakeSession:
        async def initialize(self):
            initialized["called"] = True

    @asynccontextmanager
    async def fake_sse_client(url):
        yield ("r", "w")

    @asynccontextmanager
    async def fake_client_session(read_stream, write_stream):
        yield _FakeSession()

    monkeypatch.setattr(m, "sse_client", fake_sse_client)
    monkeypatch.setattr(m, "mcp", SimpleNamespace(ClientSession=fake_client_session))

    async with m.mcp_session_context() as session:
        assert isinstance(session, _FakeSession)
    assert initialized["called"] is True


async def test_mcp_session_context_unconfigured(agents_service, monkeypatch):
    m = agents_service.mcp_tools
    monkeypatch.setattr(m.settings.mcp, "mcp_gateway_url", "")
    with pytest.raises(m.MCPToolsClientError, match="not configured"):
        async with m.mcp_session_context():
            pass  # pragma: no cover


# ===========================================================================
# title.py
# ===========================================================================
def test_normalize_title_candidates_dedup_truncate_and_filter(agents_service):
    t = agents_service.title
    long_title = "x" * (t.settings.generation.title_max_len + 50)
    raw = [
        "  Sales review  ",
        "",
        "sales review",  # casefold dup
        long_title,
        "Region breakdown",
        "Revenue trend",
        "Profit margins",  # beyond candidate count
    ]
    cleaned = t._normalize_title_candidates(raw)
    assert cleaned[0] == "Sales review"
    assert len(cleaned) == t.settings.generation.title_candidate_count
    assert all(len(item) <= t.settings.generation.title_max_len for item in cleaned)


async def test_generate_title_success(agents_service, monkeypatch):
    t = agents_service.title
    result = agents_service.schemas.ConversationTitle(
        titles=["Quarterly review", "Sales by region", "Revenue trend", "Sales by region"]
    )
    monkeypatch.setattr(t, "_title_chain", _FakeAsyncChain(result=result))

    req = agents_service.schemas.TitleRequest(user_input=[{"role": "user", "content": "Summarize sales"}])
    out = await t.generate_title(req)
    assert out.titles == ["Quarterly review", "Sales by region", "Revenue trend"]


async def test_generate_title_too_few_candidates_raises_502(agents_service, monkeypatch):
    t = agents_service.title
    result = agents_service.schemas.ConversationTitle(titles=["Only one"])
    monkeypatch.setattr(t, "_title_chain", _FakeAsyncChain(result=result))

    req = agents_service.schemas.TitleRequest(user_input=[{"role": "user", "content": "hi"}])
    with pytest.raises(HTTPException) as exc:
        await t.generate_title(req)
    assert exc.value.status_code == 502


async def test_generate_title_provider_error_raises_502(agents_service, monkeypatch):
    t = agents_service.title
    monkeypatch.setattr(t, "_title_chain", _FakeAsyncChain(error=RuntimeError("model boom")))

    req = agents_service.schemas.TitleRequest(user_input=[{"role": "user", "content": "hi"}])
    with pytest.raises(HTTPException) as exc:
        await t.generate_title(req)
    assert exc.value.status_code == 502


# ===========================================================================
# suggestions.py
# ===========================================================================
def test_normalize_suggestions_strips_dedup_and_caps(agents_service):
    s = agents_service.suggestions
    long_one = "y" * (s.settings.generation.suggestion_max_len + 20)
    raw = ["- Try this -", "", "Try this", long_one] + [f"Idea {i}" for i in range(s.settings.generation.suggestion_count)]
    cleaned = s._normalize_suggestions(raw)
    assert cleaned[0] == "Try this"
    assert len(cleaned) == s.settings.generation.suggestion_count
    assert all(len(item) <= s.settings.generation.suggestion_max_len for item in cleaned)


async def test_generate_suggestions_success(agents_service, monkeypatch):
    s = agents_service.suggestions
    full = [f"Suggestion number {i}" for i in range(s.settings.generation.suggestion_count)]
    result = agents_service.schemas.ConversationSuggestions(suggestions=full)
    monkeypatch.setattr(s, "_suggestions_chain", _FakeAsyncChain(result=result))

    req = agents_service.schemas.SuggestionsRequest(user_input=[{"role": "user", "content": "ideas"}])
    out = await s.generate_suggestions(req)
    assert len(out.suggestions) == s.settings.generation.suggestion_count


async def test_generate_suggestions_too_few_raises_502(agents_service, monkeypatch):
    s = agents_service.suggestions
    result = agents_service.schemas.ConversationSuggestions(suggestions=["only one"])
    monkeypatch.setattr(s, "_suggestions_chain", _FakeAsyncChain(result=result))

    req = agents_service.schemas.SuggestionsRequest(user_input=[{"role": "user", "content": "ideas"}])
    with pytest.raises(HTTPException) as exc:
        await s.generate_suggestions(req)
    assert exc.value.status_code == 502


async def test_generate_suggestions_provider_error_raises_502(agents_service, monkeypatch):
    s = agents_service.suggestions
    monkeypatch.setattr(s, "_suggestions_chain", _FakeAsyncChain(error=RuntimeError("boom")))

    req = agents_service.schemas.SuggestionsRequest(user_input=[{"role": "user", "content": "ideas"}])
    with pytest.raises(HTTPException) as exc:
        await s.generate_suggestions(req)
    assert exc.value.status_code == 502


# ===========================================================================
# speech.py
# ===========================================================================
def test_normalize_voice_variants(agents_service, monkeypatch):
    sp = agents_service.speech
    assert sp._normalize_voice("Echo") == "echo"
    monkeypatch.setattr(sp.settings.runtime_models, "read_aloud_voice", "shimmer")
    assert sp._normalize_voice(None) == "shimmer"
    monkeypatch.setattr(sp.settings.runtime_models, "read_aloud_voice", "")
    assert sp._normalize_voice("   ") == "alloy"


def _patch_speech_client(monkeypatch, sp, response):
    fake_client = SimpleNamespace(
        audio=SimpleNamespace(
            speech=SimpleNamespace(create=lambda **kwargs: response)
        )
    )
    monkeypatch.setattr(sp, "get_openai_client", lambda: fake_client)


def test_generate_speech_sync_bytes_content(agents_service, monkeypatch):
    sp = agents_service.speech
    _patch_speech_client(monkeypatch, sp, SimpleNamespace(content=b"audio"))
    assert sp._generate_speech_sync("hello", "alloy") == b"audio"


def test_generate_speech_sync_non_bytes_content(agents_service, monkeypatch):
    sp = agents_service.speech
    _patch_speech_client(monkeypatch, sp, SimpleNamespace(content=bytearray(b"abc")))
    assert sp._generate_speech_sync("hello", "alloy") == b"abc"


def test_generate_speech_sync_read_fallback(agents_service, monkeypatch):
    sp = agents_service.speech
    _patch_speech_client(monkeypatch, sp, SimpleNamespace(content=None, read=lambda: b"streamed"))
    assert sp._generate_speech_sync("hello", "alloy") == b"streamed"


def test_generate_speech_sync_no_audio_raises(agents_service, monkeypatch):
    sp = agents_service.speech
    _patch_speech_client(monkeypatch, sp, SimpleNamespace(content=None))
    with pytest.raises(RuntimeError, match="did not include audio"):
        sp._generate_speech_sync("hello", "alloy")


async def test_generate_read_aloud_audio_success(agents_service, monkeypatch):
    sp = agents_service.speech

    def fake_sync(text, voice):
        assert text == "Read me"
        assert voice == "alloy"
        return b"final-audio"

    monkeypatch.setattr(sp, "_generate_speech_sync", fake_sync)
    req = agents_service.schemas.ReadAloudRequest(text="Read me", voice="alloy")
    audio = await sp.generate_read_aloud_audio(req)
    assert audio == b"final-audio"


async def test_generate_read_aloud_audio_empty_text_raises_400(agents_service):
    sp = agents_service.speech
    req = agents_service.schemas.ReadAloudRequest(text="", voice="alloy")
    with pytest.raises(HTTPException) as exc:
        await sp.generate_read_aloud_audio(req)
    assert exc.value.status_code == 400


async def test_generate_read_aloud_audio_provider_error_raises_502(agents_service, monkeypatch):
    sp = agents_service.speech

    def boom(text, voice):
        raise RuntimeError("openai down")

    monkeypatch.setattr(sp, "_generate_speech_sync", boom)
    req = agents_service.schemas.ReadAloudRequest(text="Read me")
    with pytest.raises(HTTPException) as exc:
        await sp.generate_read_aloud_audio(req)
    assert exc.value.status_code == 502


async def test_generate_read_aloud_audio_empty_audio_raises_502(agents_service, monkeypatch):
    sp = agents_service.speech

    def empty(text, voice):
        return b""

    monkeypatch.setattr(sp, "_generate_speech_sync", empty)
    req = agents_service.schemas.ReadAloudRequest(text="Read me")
    with pytest.raises(HTTPException) as exc:
        await sp.generate_read_aloud_audio(req)
    assert exc.value.status_code == 502


# ===========================================================================
# prompts.py  (missing branches only; basics live in test_prompt_guards.py)
# ===========================================================================
def test_normalize_content_none_returns_empty(agents_service):
    p = agents_service.prompts
    assert p._normalize_content(None) == ""


def test_normalize_content_str_passthrough(agents_service):
    p = agents_service.prompts
    assert p._normalize_content("hello") == "hello"


def test_normalize_content_list_validates_parts(agents_service):
    p = agents_service.prompts
    out = p._normalize_content(
        [
            {"type": "text", "text": "hi"},
            {"type": "image_url", "image_url": "http://img"},
        ]
    )
    assert out == [
        {"type": "text", "text": "hi"},
        {"type": "image_url", "image_url": "http://img"},
    ]


def test_normalize_content_rejects_non_mapping_part(agents_service):
    p = agents_service.prompts
    with pytest.raises(TypeError, match="must be a dict"):
        p._normalize_content(["not-a-dict"])


def test_normalize_content_rejects_unsupported_part_type(agents_service):
    p = agents_service.prompts
    with pytest.raises(ValueError, match="Unsupported content part type"):
        p._normalize_content([{"type": "video", "src": "x"}])


def test_normalize_content_wraps_validation_error(agents_service):
    p = agents_service.prompts
    with pytest.raises(ValueError, match="Invalid content part"):
        p._normalize_content([{"type": "text"}])


def test_normalize_content_rejects_wrong_top_type(agents_service):
    p = agents_service.prompts
    with pytest.raises(TypeError, match="content must be"):
        p._normalize_content(123)


def test_dict_to_message_ai_and_system_roles(agents_service):
    p = agents_service.prompts
    ai = p.dict_to_message({"role": "assistant", "content": "answer"})
    sysm = p.dict_to_message({"role": "system", "content": "rules"})
    assert isinstance(ai, AIMessage)
    assert isinstance(sysm, SystemMessage)


def test_normalise_user_input_from_chat_prompt_template(agents_service):
    p = agents_service.prompts
    template = ChatPromptTemplate.from_messages(
        [("system", "ignored"), ("human", "Hello {name}")]
    )
    msgs = p.normalise_user_input(template, template_kwargs={"name": "Sam"})
    assert len(msgs) == 1
    assert isinstance(msgs[0], HumanMessage)
    assert "Sam" in msgs[0].content


def test_normalise_user_input_rejects_non_sequence(agents_service):
    p = agents_service.prompts
    with pytest.raises(TypeError, match="must be ChatPromptTemplate"):
        p.normalise_user_input(42)


def test_normalise_user_input_empty_returns_empty(agents_service):
    p = agents_service.prompts
    assert p.normalise_user_input([]) == []


def test_normalise_user_input_from_dicts(agents_service):
    p = agents_service.prompts
    msgs = p.normalise_user_input(
        [{"role": "system", "content": "drop me"}, {"role": "user", "content": "keep"}]
    )
    assert len(msgs) == 1
    assert msgs[0].content == "keep"


def test_normalise_user_input_rejects_bad_element_type(agents_service):
    p = agents_service.prompts
    with pytest.raises(TypeError, match="got element type"):
        p.normalise_user_input([12345])


def test_make_merge_with_template_prepends_system(agents_service):
    p = agents_service.prompts
    template = ChatPromptTemplate.from_messages([("system", "You are helpful.")])
    merge = p.make_merge_with_template(template)
    merged = merge([HumanMessage(content="Question?")])
    assert isinstance(merged[0], SystemMessage)
    assert merged[0].content == "You are helpful."
    assert merged[-1].content == "Question?"


# ===========================================================================
# skills.py
# ===========================================================================
def test_read_skill_body_strips_frontmatter(agents_service, monkeypatch, tmp_path):
    sk = agents_service.skills
    plane = tmp_path / "global"
    root = plane / "skills"
    skill_dir = root / "research" / "deep-dive"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: deep-dive\ndescription: do research\n---\n\nBody text here.",
        encoding="utf-8",
    )
    monkeypatch.setattr(agents_service.settings_module.settings.filesystem, "global_root", plane)
    body = sk._read_skill_body_from_source_path("global/research/deep-dive")
    assert body == "Body text here."


def test_read_skill_body_no_frontmatter_returns_raw(agents_service, monkeypatch, tmp_path):
    sk = agents_service.skills
    plane = tmp_path / "global"
    root = plane / "skills"
    skill_dir = root / "research" / "plain"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("Just a body, no frontmatter.", encoding="utf-8")
    monkeypatch.setattr(agents_service.settings_module.settings.filesystem, "global_root", plane)
    assert sk._read_skill_body_from_source_path("global/research/plain") == "Just a body, no frontmatter."


def test_read_skill_body_unterminated_frontmatter_returns_raw(agents_service, monkeypatch, tmp_path):
    sk = agents_service.skills
    plane = tmp_path / "global"
    root = plane / "skills"
    skill_dir = root / "research" / "broken"
    skill_dir.mkdir(parents=True)
    raw = "---\nname: broken\nno closing fence"
    (skill_dir / "SKILL.md").write_text(raw, encoding="utf-8")
    monkeypatch.setattr(agents_service.settings_module.settings.filesystem, "global_root", plane)
    assert sk._read_skill_body_from_source_path("global/research/broken") == raw


def test_read_skill_body_bad_prefix_returns_empty(agents_service):
    sk = agents_service.skills
    assert sk._read_skill_body_from_source_path("users/abc/custom/foo") == ""
    assert sk._read_skill_body_from_source_path("toolong") == ""


def test_read_skill_body_missing_file_returns_empty(agents_service, monkeypatch, tmp_path):
    sk = agents_service.skills
    monkeypatch.setattr(agents_service.settings_module.settings.filesystem, "global_root", tmp_path)
    assert sk._read_skill_body_from_source_path("global/research/ghost") == ""


def test_list_registry_skills_joins_body(agents_service, monkeypatch):
    sk = agents_service.skills
    entry = agents_service.schemas.SkillManifestEntry(
        name="deep-dive",
        type="global",
        description="do research",
        source_path="global/research/deep-dive",
        category="research",
    )
    manifest = agents_service.schemas.GlobalManifest(version=1, skills=[entry])
    monkeypatch.setattr(sk, "get_global_manifest", lambda: manifest)
    monkeypatch.setattr(sk, "_read_skill_body_from_source_path", lambda path: f"BODY:{path}")

    out = sk.list_registry_skills()
    assert len(out) == 1
    assert out[0].name == "deep-dive"
    assert out[0].category == "research"
    assert out[0].content == "BODY:global/research/deep-dive"


def test_list_user_agent_skills_delegates(agents_service, monkeypatch):
    sk = agents_service.skills
    calls = {}

    def fake_ensure(*, user_id, agent_slug):
        calls["ensure"] = (user_id, agent_slug)

    monkeypatch.setattr(sk, "ensure_user_agent_filesystem", fake_ensure)
    monkeypatch.setattr(sk, "_list_enabled_skills_fs", lambda user_id, agent_slug: ["b", "a"])

    result = sk.list_user_agent_skills("user-1", "omni")
    assert result == ["b", "a"]
    assert calls["ensure"] == ("user-1", "omni")


def test_enable_user_agent_skill_delegates(agents_service, monkeypatch):
    sk = agents_service.skills
    recorded = {}

    monkeypatch.setattr(sk, "ensure_user_agent_filesystem", lambda **kw: recorded.setdefault("ensure", kw))
    monkeypatch.setattr(sk, "_assign_user_skill_to_agent", lambda **kw: recorded.setdefault("assign", kw))

    sk.enable_user_agent_skill(user_id="user-1", agent_slug="omni", skill_name="deep-dive")
    assert recorded["assign"] == {"user_id": "user-1", "agent_slug": "omni", "skill_name": "deep-dive"}
    assert recorded["ensure"] == {"user_id": "user-1", "agent_slug": "omni"}


def test_disable_user_agent_skill_delegates(agents_service, monkeypatch):
    sk = agents_service.skills
    recorded = {}

    monkeypatch.setattr(sk, "ensure_user_agent_filesystem", lambda **kw: recorded.setdefault("ensure", kw))
    monkeypatch.setattr(sk, "_disable_skill_fs", lambda **kw: recorded.setdefault("disable", kw))

    sk.disable_user_agent_skill(user_id="user-1", agent_slug="omni", skill_name="deep-dive")
    assert recorded["disable"] == {"user_id": "user-1", "agent_slug": "omni", "skill_name": "deep-dive"}
    assert recorded["ensure"] == {"user_id": "user-1", "agent_slug": "omni"}
