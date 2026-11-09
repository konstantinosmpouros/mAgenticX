"""Langfuse tracing — opt-in, fail-open, and masked before anything leaves.

The contract (``harness/observability/langfuse.py``):

- off unless ``LANGFUSE_BASE_URL`` and both keys are set, and off means every
  run config is handed back untouched;
- on, each run gets its own handler plus the trace's name, session, tags and
  the user's pseudonym — never the raw id;
- the mask removes the patterns the Langfuse contract makes mandatory, URL
  credentials and credential-named fields, and fails closed on unknown shapes;
- a Langfuse that cannot be reached never fails or blocks a run.
"""
from __future__ import annotations

import importlib
import time
import types

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from pydantic import BaseModel, SecretStr


@pytest.fixture
def lf(agents_service):
    return importlib.import_module("harness.observability.langfuse")


@pytest.fixture
def redaction(agents_service):
    return importlib.import_module("core.logging.redaction")


class _FakeHandler:
    def __init__(self, *, public_key=None):
        self.public_key = public_key


@pytest.fixture
def tracing_on(lf, monkeypatch):
    """Tracing as if a client were live, with a stand-in handler class."""
    monkeypatch.setattr(lf, "_client", object())
    monkeypatch.setattr(lf, "CallbackHandler", _FakeHandler)
    return lf


def _configure(settings, *, url="http://langfuse-web:3000", public="pk-lf-test", secret="sk-lf-test"):
    settings.langfuse.base_url = url
    settings.langfuse.public_key = SecretStr(public)
    settings.langfuse.secret_key = SecretStr(secret)


# ---------------------------------------------------------------------------
# Settings: on only with the URL and both keys
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("url", "public", "secret", "enabled"),
    [
        ("", "", "", False),
        ("http://langfuse-web:3000", "", "", False),
        ("http://langfuse-web:3000", "pk-lf-x", "", False),
        ("", "pk-lf-x", "sk-lf-x", False),
        ("http://langfuse-web:3000", "pk-lf-x", "sk-lf-x", True),
    ],
)
def test_enabled_needs_url_and_both_keys(agents_service, url, public, secret, enabled):
    settings = agents_service.settings_module.settings
    _configure(settings, url=url, public=public, secret=secret)
    assert settings.langfuse.enabled is enabled


def test_keys_are_read_from_files(agents_service, tmp_path, monkeypatch):
    public, secret = tmp_path / "pk", tmp_path / "sk"
    public.write_text("pk-lf-from-file\n")
    secret.write_text("sk-lf-from-file\n")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "http://langfuse-web:3000")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY_FILE", str(public))
    monkeypatch.setenv("LANGFUSE_SECRET_KEY_FILE", str(secret))
    cfg = agents_service.settings_module.LangfuseSettings()
    assert cfg.public_key.get_secret_value() == "pk-lf-from-file"
    assert cfg.secret_key.get_secret_value() == "sk-lf-from-file"
    assert cfg.enabled


def test_an_unreadable_key_file_turns_tracing_off_instead_of_failing(agents_service, tmp_path, monkeypatch):
    # What Docker mounts for a `file:` secret whose source is missing: a directory.
    monkeypatch.setenv("LANGFUSE_BASE_URL", "http://langfuse-web:3000")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY_FILE", str(tmp_path))
    monkeypatch.setenv("LANGFUSE_SECRET_KEY_FILE", str(tmp_path / "absent"))
    cfg = agents_service.settings_module.LangfuseSettings()
    assert not cfg.enabled


# ---------------------------------------------------------------------------
# Off: nothing changes, nothing starts
# ---------------------------------------------------------------------------
def test_off_returns_the_same_config(lf):
    config = {"configurable": {"thread_id": "t"}, "callbacks": ["usage"]}
    assert lf.trace_run_config(config, kind="chat", name="a", session_id="c", user_id="u") is config


def test_init_without_configuration_stays_off(lf, agents_service, monkeypatch):
    _configure(agents_service.settings_module.settings, url="")
    monkeypatch.setattr(lf, "Langfuse", pytest.fail)  # must never be constructed
    lf.init_langfuse()
    assert not lf.tracing_enabled()


def test_a_client_that_cannot_start_leaves_tracing_off(lf, agents_service, monkeypatch):
    _configure(agents_service.settings_module.settings)

    def _boom(**_kwargs):
        raise ValueError("bad base url")

    monkeypatch.setattr(lf, "Langfuse", _boom)
    lf.init_langfuse()
    assert not lf.tracing_enabled()


def test_shutdown_without_a_client_is_a_no_op(lf):
    lf.shutdown_langfuse()
    assert not lf.tracing_enabled()


# ---------------------------------------------------------------------------
# On: one handler per run, the trace's attributes, the user pseudonymised
# ---------------------------------------------------------------------------
def test_on_appends_a_fresh_handler_and_keeps_existing_callbacks(tracing_on):
    config = {"configurable": {"thread_id": "t"}, "callbacks": ["usage"], "metadata": {"keep": 1}}
    first = tracing_on.trace_run_config(config, kind="chat", name="agent-x")
    second = tracing_on.trace_run_config(config, kind="chat", name="agent-x")

    assert first["callbacks"][0] == "usage"
    assert isinstance(first["callbacks"][1], _FakeHandler)
    assert first["callbacks"][1] is not second["callbacks"][1]
    assert first["metadata"]["keep"] == 1
    assert first["configurable"] == {"thread_id": "t"}
    # The caller's config is never written into.
    assert config["callbacks"] == ["usage"] and "langfuse_trace_name" not in config["metadata"]


def test_on_sets_name_session_tags_and_the_user_pseudonym(tracing_on, redaction):
    config = tracing_on.trace_run_config(
        {}, kind="workflow", name="workflow", session_id="run-1", user_id="user-123", tags=("w:1", ""),
    )
    meta = config["metadata"]
    assert meta["langfuse_trace_name"] == "workflow"
    assert meta["langfuse_session_id"] == "run-1"
    assert meta["langfuse_tags"] == sorted({"magenticx", "workflow", "w:1"})
    assert meta["langfuse_user_id"] == redaction.hash_identifier("user-123")
    assert "user-123" not in str(meta)


def test_on_without_session_or_user_omits_them(tracing_on):
    meta = tracing_on.trace_run_config({}, kind="title", name="title")["metadata"]
    assert "langfuse_session_id" not in meta and "langfuse_user_id" not in meta


def test_a_callback_manager_is_left_alone(tracing_on):
    manager = object()
    config = {"callbacks": manager}
    assert tracing_on.trace_run_config(config, kind="chat", name="a") is config


def test_base_agent_traces_chat_and_subagent_runs(tracing_on, agents_service):
    base_agent = importlib.import_module("harness.abstractions.base_agent")

    class _Agent(base_agent.BaseAgent):
        name = "probe"

    chat = _Agent(config={
        "context": {"user_id": "u1", "conversation_id": "c1"},
        "run_config": {"configurable": {"thread_id": "branch-1"}},
    })
    meta = chat._traced_config()["metadata"]
    assert meta["langfuse_session_id"] == "c1"
    assert "chat" in meta["langfuse_tags"] and "probe" in meta["langfuse_tags"]

    task = _Agent(config={
        "context": {"user_id": "u1", "conversation_id": "c1", "async_task_id": "task-9"},
        "run_config": {"configurable": {"thread_id": "task-9"}},
    })
    meta = task._traced_config()["metadata"]
    assert meta["langfuse_session_id"] == "c1"  # the parent conversation's session
    assert "subagent" in meta["langfuse_tags"]


# ---------------------------------------------------------------------------
# The mask
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("key pk-lf-1234567890abcdef here", "[REDACTED_LANGFUSE_KEY]"),
        ("sk-proj-ABCDEFGHIJKLMNOPQRSTUV", "[REDACTED_API_KEY]"),
        ("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV", "[REDACTED_API_KEY]"),
        ("AKIAABCDEFGHIJKLMNOP", "[REDACTED_AWS_KEY]"),
        ("ghp_" + "a" * 36, "[REDACTED_GITHUB_TOKEN]"),
        ("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop", "[REDACTED_JWT]"),
        ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "Bearer [REDACTED]"),
        ("write to jane.doe@example.com", "[REDACTED_EMAIL]"),
        ("postgresql://admin:hunter2@chat_postgres:5432/db", "postgresql://[REDACTED]@chat_postgres"),
    ],
)
def test_mask_removes_secret_patterns(lf, raw, expected):
    masked = lf.mask(data=raw)
    assert expected in masked
    for secret in ("1234567890abcdef", "ABCDEFGHIJKLMNOPQRSTUV", "AKIAABCDEFGHIJKLMNOP",
                   "a" * 36, "abcdefghijklmnop", "jane.doe", "hunter2"):
        assert secret not in masked


def test_mask_walks_nested_structures_and_blanks_credential_fields(lf):
    data = {
        "messages": [{"role": "user", "content": "mail me at a@b.co"}],
        "tool_args": {"password": "hunter2", "api_token": "abc", "max_tokens": 512},
        "tuple": ("sk-proj-ABCDEFGHIJKLMNOPQRSTUV",),
        "n": 3, "ok": True, "none": None,
    }
    masked = lf.mask(data=data)
    assert masked["messages"][0]["content"] == "mail me at [REDACTED_EMAIL]"
    assert masked["tool_args"] == {"password": "[REDACTED]", "api_token": "[REDACTED]", "max_tokens": 512}
    assert masked["tuple"] == ["[REDACTED_API_KEY]"]
    assert (masked["n"], masked["ok"], masked["none"]) == (3, True, None)
    assert data["tool_args"]["password"] == "hunter2"  # the input is not mutated


def test_mask_fails_closed_on_unknown_shapes(lf):
    class Payload(BaseModel):
        note: str

    class Opaque:
        def __str__(self):
            return "token=sk-proj-ABCDEFGHIJKLMNOPQRSTUV"

    assert lf.mask(data=Payload(note="x@y.io")) == {"note": "[REDACTED_EMAIL]"}
    assert "ABCDEFGHIJKLMNOPQRSTUV" not in lf.mask(data=Opaque())
    assert lf.mask(data=b"\x00\x01") == "<bytes:2>"


def test_mask_bounds_pathological_depth(lf):
    deep: list = []
    node = deep
    for _ in range(200):
        child: list = []
        node.append(child)
        node = child
    assert "[TRUNCATED]" in str(lf.mask(data=deep))


# ---------------------------------------------------------------------------
# Fail-open end to end: a real client, Langfuse unreachable
# ---------------------------------------------------------------------------
async def test_an_unreachable_langfuse_never_fails_or_blocks_a_run(lf, agents_service):
    settings = agents_service.settings_module.settings
    # Port 9 (discard) on loopback: refused at once, nothing listens.
    _configure(settings, url="http://127.0.0.1:9", public="pk-lf-unreachable", secret="sk-lf-unreachable")
    settings.langfuse.timeout_seconds = 1
    lf.init_langfuse()
    try:
        assert lf.tracing_enabled()
        model = FakeListChatModel(responses=["fine"])
        config = lf.trace_run_config({}, kind="chat", name="probe", session_id="c1", user_id="u1")
        started = time.monotonic()
        reply = await model.ainvoke("hello sk-proj-ABCDEFGHIJKLMNOPQRSTUV", config=config)
        assert reply.content == "fine"
        assert time.monotonic() - started < 2  # the run does not wait on the export
    finally:
        started = time.monotonic()
        lf.shutdown_langfuse()
        assert time.monotonic() - started < 30  # the flush is bounded
    assert not lf.tracing_enabled()


def test_shutdown_survives_a_failing_flush(lf, monkeypatch):
    client = types.SimpleNamespace(shutdown=lambda: (_ for _ in ()).throw(RuntimeError("export failed")))
    monkeypatch.setattr(lf, "_client", client)
    lf.shutdown_langfuse()
    assert not lf.tracing_enabled()
