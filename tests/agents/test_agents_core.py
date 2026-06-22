from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from starlette.requests import Request


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_request(
    *,
    headers: dict[str, str] | None = None,
    client: tuple[str, int] | None = ("203.0.113.7", 12345),
) -> Request:
    raw_headers = [
        (key.lower().encode("latin-1"), value.encode("latin-1"))
        for key, value in (headers or {}).items()
    ]
    scope: dict[str, Any] = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": raw_headers,
        "client": client,
        "scheme": "http",
        "server": ("testserver", 80),
    }
    return Request(scope)


class _RecordingLogger:
    """Captures structured-logger calls without a real backend."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def _record(self, method: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
        self.calls.append((method, args, kwargs))

    def log(self, *args: Any, **kwargs: Any) -> None:
        self._record("log", args, kwargs)

    def warning(self, *args: Any, **kwargs: Any) -> None:
        self._record("warning", args, kwargs)

    def error(self, *args: Any, **kwargs: Any) -> None:
        self._record("error", args, kwargs)

    def exception(self, *args: Any, **kwargs: Any) -> None:
        self._record("exception", args, kwargs)


# ---------------------------------------------------------------------------
# core/proxy.py
# ---------------------------------------------------------------------------
def test_normalize_ip_variants(agents_service):
    proxy = agents_service.proxy
    assert proxy._normalize_ip(" 192.168.0.1 ") == "192.168.0.1"
    assert proxy._normalize_ip(None) is None
    assert proxy._normalize_ip("   ") is None
    assert proxy._normalize_ip("not-an-ip") is None


def test_first_forwarded_for_ip(agents_service):
    proxy = agents_service.proxy
    assert proxy._first_forwarded_for_ip(None) is None
    assert proxy._first_forwarded_for_ip("garbage, also-bad") is None
    assert proxy._first_forwarded_for_ip("bad, 10.0.0.5, 10.0.0.6") == "10.0.0.5"


def test_remote_ip_no_client(agents_service):
    proxy = agents_service.proxy
    assert proxy._remote_ip(_make_request(client=None)) is None
    assert proxy._remote_ip(_make_request(client=("198.51.100.9", 5))) == "198.51.100.9"


def test_is_trusted_proxy_request(agents_service):
    proxy = agents_service.proxy
    header = proxy.TRUSTED_PROXY_HEADER_NAME
    secret = agents_service.settings_module.settings.proxy.trusted_proxy_secret.get_secret_value()

    assert proxy.is_trusted_proxy_request(_make_request(headers={header: secret})) is True
    assert proxy.is_trusted_proxy_request(_make_request(headers={header: "wrong"})) is False
    assert proxy.is_trusted_proxy_request(_make_request(headers={})) is False


def test_require_internal_caller(agents_service):
    proxy = agents_service.proxy
    header = proxy.TRUSTED_PROXY_HEADER_NAME
    secret = agents_service.settings_module.settings.proxy.trusted_proxy_secret.get_secret_value()

    assert proxy.require_internal_caller(_make_request(headers={header: secret})) is None

    with pytest.raises(HTTPException) as excinfo:
        proxy.require_internal_caller(_make_request(headers={}))
    assert excinfo.value.status_code == 403


def test_internal_service_headers(agents_service):
    proxy = agents_service.proxy
    header = proxy.TRUSTED_PROXY_HEADER_NAME
    secret = agents_service.settings_module.settings.proxy.trusted_proxy_secret.get_secret_value()

    without_id = proxy.internal_service_headers()
    assert without_id == {header: secret}

    with_id = proxy.internal_service_headers("req-123")
    assert with_id[header] == secret
    assert with_id["X-Request-ID"] == "req-123"


def test_resolve_client_ip_untrusted_returns_remote(agents_service):
    proxy = agents_service.proxy
    # Untrusted caller: forwarded headers ignored, falls back to remote client.
    request = _make_request(
        headers={"x-forwarded-for": "1.2.3.4"},
        client=("198.51.100.10", 5),
    )
    assert proxy.resolve_client_ip(request) == "198.51.100.10"


def test_resolve_client_ip_trusted_prefers_cf_connecting_ip(agents_service):
    proxy = agents_service.proxy
    header = proxy.TRUSTED_PROXY_HEADER_NAME
    secret = agents_service.settings_module.settings.proxy.trusted_proxy_secret.get_secret_value()

    request = _make_request(
        headers={
            header: secret,
            "cf-connecting-ip": "9.9.9.9",
            "x-forwarded-for": "8.8.8.8",
            "x-real-ip": "7.7.7.7",
        },
        client=("198.51.100.10", 5),
    )
    assert proxy.resolve_client_ip(request) == "9.9.9.9"


def test_resolve_client_ip_trusted_falls_through_to_forwarded_for(agents_service):
    proxy = agents_service.proxy
    header = proxy.TRUSTED_PROXY_HEADER_NAME
    secret = agents_service.settings_module.settings.proxy.trusted_proxy_secret.get_secret_value()

    request = _make_request(
        headers={
            header: secret,
            "x-forwarded-for": "bad, 8.8.4.4",
            "x-real-ip": "7.7.7.7",
        },
        client=("198.51.100.10", 5),
    )
    assert proxy.resolve_client_ip(request) == "8.8.4.4"


def test_resolve_client_ip_trusted_falls_through_to_real_ip(agents_service):
    proxy = agents_service.proxy
    header = proxy.TRUSTED_PROXY_HEADER_NAME
    secret = agents_service.settings_module.settings.proxy.trusted_proxy_secret.get_secret_value()

    request = _make_request(
        headers={header: secret, "x-real-ip": "7.7.7.7"},
        client=("198.51.100.10", 5),
    )
    assert proxy.resolve_client_ip(request) == "7.7.7.7"


def test_resolve_client_ip_trusted_no_forwarded_returns_remote(agents_service):
    proxy = agents_service.proxy
    header = proxy.TRUSTED_PROXY_HEADER_NAME
    secret = agents_service.settings_module.settings.proxy.trusted_proxy_secret.get_secret_value()

    request = _make_request(
        headers={header: secret},
        client=("198.51.100.10", 5),
    )
    assert proxy.resolve_client_ip(request) == "198.51.100.10"


# ---------------------------------------------------------------------------
# core/error_handling.py
# ---------------------------------------------------------------------------
async def test_handle_http_exception_client_error(agents_service):
    logger = _RecordingLogger()
    handler = agents_service.error_handling.AgentServiceExceptionHandler(logger)

    exc = HTTPException(status_code=404, detail="Not found", headers={"X-Foo": "bar"})
    response = await handler.handle_http_exception(_make_request(), exc)

    assert response.status_code == 404
    assert json.loads(response.body) == {"detail": "Not found"}
    assert response.headers["X-Foo"] == "bar"

    method, args, kwargs = logger.calls[0]
    assert method == "log"
    # status < 500 → no exc_info, detail withheld at WARNING.
    assert kwargs["exc_info"] is False
    assert kwargs["detail"] is None


async def test_handle_http_exception_server_error(agents_service):
    logger = _RecordingLogger()
    handler = agents_service.error_handling.AgentServiceExceptionHandler(logger)

    exc = HTTPException(status_code=500, detail="boom")
    response = await handler.handle_http_exception(_make_request(), exc)

    assert response.status_code == 500
    assert json.loads(response.body) == {"detail": "boom"}

    method, args, kwargs = logger.calls[0]
    assert kwargs["exc_info"] is True
    assert kwargs["detail"] == "boom"


async def test_handle_http_exception_blank_detail_uses_fallback(agents_service):
    logger = _RecordingLogger()
    handler = agents_service.error_handling.AgentServiceExceptionHandler(logger)

    exc = HTTPException(status_code=400, detail="   ")
    response = await handler.handle_http_exception(_make_request(), exc)

    assert response.status_code == 400
    assert json.loads(response.body) == {
        "detail": "Request could not be completed. Please try again."
    }


async def test_handle_validation_exception(agents_service):
    logger = _RecordingLogger()
    handler = agents_service.error_handling.AgentServiceExceptionHandler(logger)

    class _FakeValidationError:
        def errors(self, include_input: bool = True):
            assert include_input is False
            return [{"loc": ("body", "x"), "msg": "field required", "type": "missing"}]

    response = await handler.handle_validation_exception(_make_request(), _FakeValidationError())

    assert response.status_code == 422
    assert "Invalid request" in json.loads(response.body)["detail"]
    assert logger.calls[0][0] == "warning"


async def test_handle_unhandled_exception(agents_service):
    logger = _RecordingLogger()
    handler = agents_service.error_handling.AgentServiceExceptionHandler(logger)

    response = await handler.handle_unhandled_exception(_make_request(), RuntimeError("kaboom"))

    assert response.status_code == 500
    assert json.loads(response.body) == {"detail": "Something went wrong. Please try again."}
    assert logger.calls[0][0] == "exception"


def test_public_http_detail(agents_service):
    handler_cls = agents_service.error_handling.AgentServiceExceptionHandler
    assert handler_cls._public_http_detail(HTTPException(status_code=400, detail="real")) == "real"
    fallback = handler_cls._public_http_detail(HTTPException(status_code=400, detail=""))
    assert fallback == "Request could not be completed. Please try again."
    # Non-string detail also hits the fallback branch.
    assert handler_cls._public_http_detail(
        HTTPException(status_code=400, detail={"k": "v"})
    ) == "Request could not be completed. Please try again."


def test_provider_error_handler_raises_502(agents_service):
    logger = _RecordingLogger()
    handler = agents_service.error_handling.provider_error_handler

    with pytest.raises(HTTPException) as excinfo:
        handler.raise_provider_error(
            logger,
            ValueError("upstream down"),
            event="provider_failed",
            message="Provider request failed",
            public_detail="Upstream unavailable.",
            provider="openai",
            operation="chat",
            extra="ctx",
        )
    assert excinfo.value.status_code == 502
    assert excinfo.value.detail == "Upstream unavailable."
    assert logger.calls[0][0] == "warning"
    assert logger.calls[0][2]["failure_reason"] == "provider_request_failed"


def test_provider_error_handler_invalid_response(agents_service):
    logger = _RecordingLogger()
    handler = agents_service.error_handling.provider_error_handler

    with pytest.raises(HTTPException) as excinfo:
        handler.raise_invalid_response(
            logger,
            event="bad_response",
            message="Invalid provider response",
            public_detail="Bad upstream response.",
            provider="openai",
            operation="chat",
        )
    assert excinfo.value.status_code == 502
    assert excinfo.value.detail == "Bad upstream response."
    assert logger.calls[0][0] == "error"
    assert logger.calls[0][2]["failure_reason"] == "invalid_provider_response"


def test_encode_run_error_frame(agents_service):
    logger = _RecordingLogger()
    handler = agents_service.error_handling.agent_stream_error_handler

    frame = handler.encode_run_error(
        logger,
        RuntimeError("nope"),
        agent_slug="omni",
        public_message="Custom failure.",
    )
    assert frame.startswith(b"data: ")
    assert frame.endswith(b"\n\n")
    payload = json.loads(frame[len(b"data: ") : -2].decode("utf-8"))
    assert payload == {"type": "RUN_ERROR", "message": "Custom failure."}
    assert logger.calls[0][0] == "error"
    assert logger.calls[0][2]["agent_slug"] == "omni"


def test_encode_run_error_default_message(agents_service):
    handler = agents_service.error_handling.agent_stream_error_handler
    frame = handler.encode_run_error(_RecordingLogger(), ValueError("x"), agent_slug="hr")
    payload = json.loads(frame[len(b"data: ") : -2].decode("utf-8"))
    assert payload["message"] == "The agent could not complete this run. Please try again."


# ---------------------------------------------------------------------------
# core/settings.py
# ---------------------------------------------------------------------------
def test_resolve_file_backed_secret_from_file(agents_service, tmp_path, monkeypatch):
    settings_module = agents_service.settings_module
    secret_file = tmp_path / "secret.txt"
    secret_file.write_text("  file-secret-value  ")

    monkeypatch.setenv("MY_TEST_SECRET_FILE", str(secret_file))
    monkeypatch.delenv("MY_TEST_SECRET", raising=False)

    assert settings_module._resolve_file_backed_secret("MY_TEST_SECRET") == "file-secret-value"


def test_resolve_file_backed_secret_file_unreadable_raises(agents_service, tmp_path, monkeypatch):
    settings_module = agents_service.settings_module
    missing = tmp_path / "does-not-exist.txt"

    monkeypatch.setenv("MY_TEST_SECRET_FILE", str(missing))
    monkeypatch.delenv("MY_TEST_SECRET", raising=False)

    with pytest.raises(RuntimeError) as excinfo:
        settings_module._resolve_file_backed_secret("MY_TEST_SECRET")
    assert "could not be read" in str(excinfo.value)


def test_resolve_file_backed_secret_empty_file_then_env(agents_service, tmp_path, monkeypatch):
    settings_module = agents_service.settings_module
    empty_file = tmp_path / "empty.txt"
    empty_file.write_text("   ")

    monkeypatch.setenv("MY_TEST_SECRET_FILE", str(empty_file))
    monkeypatch.setenv("MY_TEST_SECRET", "  env-secret  ")

    assert settings_module._resolve_file_backed_secret("MY_TEST_SECRET") == "env-secret"


def test_resolve_file_backed_secret_from_env(agents_service, monkeypatch):
    settings_module = agents_service.settings_module
    monkeypatch.delenv("MY_TEST_SECRET_FILE", raising=False)
    monkeypatch.setenv("MY_TEST_SECRET", "plain-env")
    assert settings_module._resolve_file_backed_secret("MY_TEST_SECRET") == "plain-env"


def test_resolve_file_backed_secret_missing_returns_none(agents_service, monkeypatch):
    settings_module = agents_service.settings_module
    monkeypatch.delenv("ABSENT_SECRET_FILE", raising=False)
    monkeypatch.delenv("ABSENT_SECRET", raising=False)
    assert settings_module._resolve_file_backed_secret("ABSENT_SECRET") is None


def test_parse_csv(agents_service):
    settings_module = agents_service.settings_module
    assert settings_module._parse_csv(None) == ()
    assert settings_module._parse_csv(["a", " b ", "", "c"]) == ("a", "b", "c")
    assert settings_module._parse_csv(("x", "  ")) == ("x",)
    assert settings_module._parse_csv("one, two ,, three") == ("one", "two", "three")


def test_normalize_helpers(agents_service):
    settings_module = agents_service.settings_module
    assert settings_module._normalize_slug("  Foo-Bar  ") == "foo-bar"
    assert settings_module._normalize_table_name("Financial Sample!") == "financial_sample"
    assert settings_module._normalize_table_name("  multi   space  ") == "multi_space"


def test_api_keys_settings_branches(agents_service):
    settings_module = agents_service.settings_module
    from pydantic import SecretStr

    # SecretStr with value passes through.
    populated = settings_module.ApiKeysSettings(openai=SecretStr("sk-direct"))
    assert populated.openai.get_secret_value() == "sk-direct"

    # Empty SecretStr → None.
    empty = settings_module.ApiKeysSettings(openai=SecretStr(""))
    assert empty.openai is None

    # Plain string is stripped (both validators).
    stripped = settings_module.ApiKeysSettings(
        openai="  sk-openai  ", anthropic="  sk-anthropic  "
    )
    assert stripped.openai.get_secret_value() == "sk-openai"
    assert stripped.anthropic.get_secret_value() == "sk-anthropic"

    # Empty SecretStr on the anthropic validator → None (mirror of openai).
    empty_anthropic = settings_module.ApiKeysSettings(anthropic=SecretStr(""))
    assert empty_anthropic.anthropic is None


def test_api_keys_settings_falls_back_to_resolver(agents_service, monkeypatch):
    settings_module = agents_service.settings_module
    monkeypatch.delenv("ANTHROPIC_API_KEY_FILE", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
    instance = settings_module.ApiKeysSettings(anthropic=None)
    assert instance.anthropic.get_secret_value() == "from-env"


def test_proxy_settings_secret_branches(agents_service, monkeypatch):
    settings_module = agents_service.settings_module
    from pydantic import SecretStr

    direct = settings_module.ProxySettings(trusted_proxy_secret=SecretStr("abc"))
    assert direct.trusted_proxy_secret.get_secret_value() == "abc"

    as_str = settings_module.ProxySettings(trusted_proxy_secret="xyz")
    assert as_str.trusted_proxy_secret.get_secret_value() == "xyz"

    monkeypatch.setenv("TRUSTED_PROXY_SECRET", "resolved-secret")
    resolved = settings_module.ProxySettings(trusted_proxy_secret=SecretStr(""))
    assert resolved.trusted_proxy_secret.get_secret_value() == "resolved-secret"


def test_proxy_settings_secret_missing_returns_empty(agents_service, monkeypatch):
    settings_module = agents_service.settings_module
    from pydantic import SecretStr

    monkeypatch.delenv("TRUSTED_PROXY_SECRET", raising=False)
    monkeypatch.delenv("TRUSTED_PROXY_SECRET_FILE", raising=False)
    empty = settings_module.ProxySettings(trusted_proxy_secret=SecretStr(""))
    assert empty.trusted_proxy_secret.get_secret_value() == ""


def test_logging_settings_normalization(agents_service):
    settings_module = agents_service.settings_module
    from pydantic import SecretStr

    instance = settings_module.LoggingSettings(LOG_LEVEL="debug", LOG_FORMAT="  JSON  ")
    assert instance.level == "DEBUG"
    assert instance.format == "json"

    # Redaction secret: direct SecretStr, plain string, and fallback default.
    direct = settings_module.LoggingSettings(redaction_secret=SecretStr("redact-me"))
    assert direct.redaction_secret.get_secret_value() == "redact-me"

    as_str = settings_module.LoggingSettings(redaction_secret="plain-redact")
    assert as_str.redaction_secret.get_secret_value() == "plain-redact"


def test_logging_settings_redaction_fallback_default(agents_service, monkeypatch):
    settings_module = agents_service.settings_module
    from pydantic import SecretStr

    monkeypatch.delenv("LOG_REDACTION_SECRET", raising=False)
    monkeypatch.delenv("LOG_REDACTION_SECRET_FILE", raising=False)
    monkeypatch.delenv("SESSION_TOKEN_SECRET", raising=False)
    monkeypatch.delenv("SESSION_TOKEN_SECRET_FILE", raising=False)
    instance = settings_module.LoggingSettings(redaction_secret=SecretStr(""))
    assert instance.redaction_secret.get_secret_value() == "agents-log-redaction"


def test_agent_registry_slug_parsing(agents_service):
    settings_module = agents_service.settings_module

    from_list = settings_module.AgentRegistrySettings(
        DISABLED_AGENT_SLUGS=["Foo", " Bar ", ""]
    )
    assert from_list.disabled_agent_slugs == ("foo", "bar")

    from_none = settings_module.AgentRegistrySettings(DISABLED_AGENT_SLUGS=None)
    assert from_none.disabled_agent_slugs == ()

    # CSV string dedups (case-insensitive) and preserves order.
    from_csv = settings_module.AgentRegistrySettings(
        DISABLED_AGENT_SLUGS="Alpha, beta, ALPHA, , gamma"
    )
    assert from_csv.disabled_agent_slugs == ("alpha", "beta", "gamma")


def test_retail_workflow_derives_table_name(agents_service):
    settings_module = agents_service.settings_module
    derived = settings_module.RetailWorkflowSettings(RETAIL_TABLE_NAME="Financial Sample")
    assert derived.table_name == "financial_sample"

    explicit = settings_module.RetailWorkflowSettings(
        RETAIL_TABLE_NAME="Financial Sample", table_name="custom_name"
    )
    assert explicit.table_name == "custom_name"


def test_rag_settings_url_builders(agents_service):
    settings_module = agents_service.settings_module
    rag = settings_module.RagSettings(RAG_BASE_URL="https://rag.test/")
    assert rag.retrieve_url("col") == "https://rag.test/retrieve/col"
    assert rag.excel_schema_url("tbl") == "https://rag.test/excel/tbl/schema"
    assert rag.excel_query_url("tbl") == "https://rag.test/excel/tbl/query/sql"


def test_settings_requires_proxy_secret(agents_service, monkeypatch):
    settings_module = agents_service.settings_module
    from pydantic import ValidationError

    monkeypatch.delenv("TRUSTED_PROXY_SECRET", raising=False)
    monkeypatch.delenv("TRUSTED_PROXY_SECRET_FILE", raising=False)

    with pytest.raises(ValidationError) as excinfo:
        settings_module.Settings(
            proxy=settings_module.ProxySettings(trusted_proxy_secret="")
        )
    assert "TRUSTED_PROXY_SECRET must be set" in str(excinfo.value)


def test_settings_builds_with_proxy_secret(agents_service):
    settings_module = agents_service.settings_module
    instance = settings_module.Settings(
        proxy=settings_module.ProxySettings(trusted_proxy_secret="present")
    )
    assert instance.proxy.trusted_proxy_secret.get_secret_value() == "present"


# ---------------------------------------------------------------------------
# runtime/checkpointer/store.py  (shared durable-saver accessor)
# ---------------------------------------------------------------------------
def test_set_and_get_checkpointer(agents_service):
    store = agents_service.checkpointer_store
    sentinel = object()
    store.set_checkpointer(sentinel)
    assert store.has_checkpointer_initialized() is True
    assert store.get_checkpointer() is sentinel
    # The accessor is the same handle every call (single process-wide saver).
    assert store.get_checkpointer() is sentinel


def test_get_checkpointer_uninitialized_raises(agents_service, monkeypatch):
    store = agents_service.checkpointer_store
    monkeypatch.setattr(store, "_checkpointer", None)
    assert store.has_checkpointer_initialized() is False
    with pytest.raises(RuntimeError):
        store.get_checkpointer()


# ---------------------------------------------------------------------------
# utils/checkpointer.py  (namespace-cache release — never deletes Postgres)
# ---------------------------------------------------------------------------
class _FakeSnapshot:
    def __init__(self, interrupts: Any) -> None:
        self.interrupts = interrupts


class _FakeCompiled:
    """Stubs the async ``aget_state`` the durable saver exposes."""

    def __init__(self, snapshot: Any = None, raises: bool = False) -> None:
        self._snapshot = snapshot
        self._raises = raises
        self.calls: list[Any] = []

    async def aget_state(self, run_config: Any) -> Any:
        self.calls.append(run_config)
        if self._raises:
            raise RuntimeError("probe failure")
        return self._snapshot


class _FakeAgent:
    def __init__(self, compiled: Any, run_config: Any) -> None:
        self.compiled = compiled
        self.run_config = run_config


async def test_release_checkpoint_unless_paused_empty_run_id(agents_service, monkeypatch):
    util = agents_service.checkpointer_util
    released: list[str] = []
    monkeypatch.setattr(util, "release_namespace_bindings", lambda run_id: released.append(run_id))
    await util.release_checkpoint_unless_paused(object(), "")
    assert released == []


async def test_release_checkpoint_unless_paused_keeps_on_pending_interrupt(agents_service, monkeypatch):
    util = agents_service.checkpointer_util
    released: list[str] = []
    monkeypatch.setattr(util, "release_namespace_bindings", lambda run_id: released.append(run_id))

    agent = _FakeAgent(
        compiled=_FakeCompiled(snapshot=_FakeSnapshot(interrupts=["pending"])),
        run_config={"configurable": {"thread_id": "t1"}},
    )
    await util.release_checkpoint_unless_paused(agent, "run-1")
    assert released == []


async def test_release_checkpoint_unless_paused_releases_when_no_interrupt(agents_service, monkeypatch):
    util = agents_service.checkpointer_util
    released: list[str] = []
    monkeypatch.setattr(util, "release_namespace_bindings", lambda run_id: released.append(run_id))

    agent = _FakeAgent(
        compiled=_FakeCompiled(snapshot=_FakeSnapshot(interrupts=[])),
        run_config={"configurable": {"thread_id": "t2"}},
    )
    await util.release_checkpoint_unless_paused(agent, "run-2")
    assert released == ["run-2"]


async def test_release_checkpoint_unless_paused_releases_on_probe_failure(agents_service, monkeypatch):
    util = agents_service.checkpointer_util
    released: list[str] = []
    monkeypatch.setattr(util, "release_namespace_bindings", lambda run_id: released.append(run_id))

    agent = _FakeAgent(
        compiled=_FakeCompiled(raises=True),
        run_config={"configurable": {"thread_id": "t3"}},
    )
    await util.release_checkpoint_unless_paused(agent, "run-3")
    assert released == ["run-3"]


async def test_release_checkpoint_unless_paused_no_aget_state(agents_service, monkeypatch):
    util = agents_service.checkpointer_util
    released: list[str] = []
    monkeypatch.setattr(util, "release_namespace_bindings", lambda run_id: released.append(run_id))

    # Agent without a `.compiled.aget_state` → falls straight to release.
    agent = _FakeAgent(compiled=None, run_config={})
    await util.release_checkpoint_unless_paused(agent, "run-4")
    assert released == ["run-4"]


# ---------------------------------------------------------------------------
# runtime/checkpointer/fork.py  (copy-on-fork seeding)
# ---------------------------------------------------------------------------
class _ForkGraph:
    """Stub graph: records aupdate_state calls; aget_state returns canned snapshots."""

    def __init__(self, states: dict[tuple, Any]) -> None:
        # keyed by (thread_id, checkpoint_id|None)
        self._states = states
        self.updated: list[tuple[str, Any]] = []

    async def aget_state(self, config: Any) -> Any:
        cfg = config["configurable"]
        return self._states.get((cfg["thread_id"], cfg.get("checkpoint_id")))

    async def aupdate_state(self, config: Any, values: Any) -> None:
        self.updated.append((config["configurable"]["thread_id"], values))


async def test_fork_seeds_empty_target_from_source(agents_service):
    fork = agents_service.checkpointer_fork
    src_values = {"messages": ["m1", "m2"], "files": {"/x": 1}}
    graph = _ForkGraph(
        {
            ("new", None): SimpleNamespace(values={}),          # target empty
            ("src", "cp-9"): SimpleNamespace(values=src_values),  # source at fork point
        }
    )
    ok = await fork.seed_thread_from_checkpoint(
        graph=graph, source_thread_id="src", source_checkpoint_id="cp-9", target_thread_id="new"
    )
    assert ok is True
    assert graph.updated == [("new", src_values)]


async def test_fork_skips_when_target_already_seeded(agents_service):
    fork = agents_service.checkpointer_fork
    graph = _ForkGraph({("new", None): SimpleNamespace(values={"messages": ["existing"]})})
    ok = await fork.seed_thread_from_checkpoint(
        graph=graph, source_thread_id="src", source_checkpoint_id="cp-9", target_thread_id="new"
    )
    assert ok is True
    assert graph.updated == []  # never re-seeds a non-empty target


async def test_fork_returns_false_on_empty_source(agents_service):
    fork = agents_service.checkpointer_fork
    graph = _ForkGraph(
        {
            ("new", None): SimpleNamespace(values={}),
            ("src", "cp-9"): SimpleNamespace(values={}),  # nothing to copy
        }
    )
    ok = await fork.seed_thread_from_checkpoint(
        graph=graph, source_thread_id="src", source_checkpoint_id="cp-9", target_thread_id="new"
    )
    assert ok is False
    assert graph.updated == []


# ---------------------------------------------------------------------------
# runtime/base_agent.py
# ---------------------------------------------------------------------------
class _NamedTool:
    # _extract_tool_identity reads only `.name`; server_id is inferred via the
    # _TOOL_SERVER_OVERRIDES table, so a bare-name stand-in is sufficient.
    def __init__(self, name: str) -> None:
        self.name = name


def test_base_agent_manifest(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    manifest = BaseAgent.manifest()
    assert manifest["id"] == "base-agent"
    assert manifest["slug"] == "base-agent"
    assert manifest["name"] == "Base Agent"
    assert manifest["type"] == "langgraph agent"
    assert manifest["description"] == ""
    assert manifest["icon"] == ""


def test_base_agent_metadata_property(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    agent = BaseAgent()
    assert agent.metadata == BaseAgent.manifest()


def test_base_agent_default_construction(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    agent = BaseAgent()
    assert agent.config == {}
    assert "configurable" in agent.run_config
    assert "thread_id" in agent.run_config["configurable"]
    assert agent.config_tools == []
    assert agent.config_tool_names == []
    assert agent.tools == []
    assert agent.context == {}


def test_base_agent_valid_full_config(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    config = {
        "tools": [
            {"tool_name": "  search  ", "server_id": "  tavily  "},
            {"tool_name": "fetch"},
        ],
        "run_config": {"configurable": {"thread_id": "abc"}},
        "context": {"user_id": "  u1 ", "conversation_id": " c1 "},
    }
    agent = BaseAgent(config=config)

    assert agent.config["tools"][0] == {"tool_name": "search", "server_id": "tavily"}
    assert agent.config["tools"][1] == {"tool_name": "fetch", "server_id": ""}
    assert agent.run_config == {"configurable": {"thread_id": "abc"}}
    assert agent.context == {"user_id": "u1", "conversation_id": "c1"}
    # config_tool_names are normalized cache keys.
    assert agent.config_tool_names == ["tavily/search", "fetch"]


def test_base_agent_run_config_none_uses_default(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    agent = BaseAgent(config={"context": {"user_id": "u", "conversation_id": "c"}})
    assert "configurable" in agent.run_config
    assert "thread_id" in agent.run_config["configurable"]


def test_base_agent_invalid_tools_not_sequence(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(TypeError):
        BaseAgent(config={"tools": "not-a-list"})


def test_base_agent_invalid_tool_entry_type(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(TypeError):
        BaseAgent(config={"tools": ["not-a-mapping"]})


def test_base_agent_validate_tool_config_rejects_string_directly(agents_service):
    # The static helper guards against a bare string even when called directly.
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(TypeError):
        BaseAgent._validate_tool_config("not-a-list")


def test_base_agent_tool_missing_name(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(ValueError):
        BaseAgent(config={"tools": [{"server_id": "tavily"}]})


def test_base_agent_tool_blank_name(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(ValueError):
        BaseAgent(config={"tools": [{"tool_name": "   "}]})


def test_base_agent_tool_server_id_none_and_coerced(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    agent = BaseAgent(config={"tools": [{"tool_name": "x", "server_id": None}]})
    assert agent.config["tools"][0]["server_id"] == ""

    agent2 = BaseAgent(config={"tools": [{"tool_name": "x", "server_id": 123}]})
    assert agent2.config["tools"][0]["server_id"] == "123"


def test_base_agent_invalid_run_config_type(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(TypeError):
        BaseAgent(config={"run_config": "not-a-mapping"})


def test_base_agent_invalid_configurable_type(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(TypeError):
        BaseAgent(config={"run_config": {"configurable": "not-a-mapping"}})


def test_base_agent_run_config_configurable_none_ok(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    agent = BaseAgent(config={"run_config": {"other": "value"}})
    assert agent.run_config == {"other": "value"}


def test_base_agent_invalid_context_type(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(TypeError):
        BaseAgent(config={"context": "not-a-mapping"})


def test_base_agent_context_missing_field(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(ValueError):
        BaseAgent(config={"context": {"user_id": "u"}})


def test_base_agent_context_blank_field(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    with pytest.raises(ValueError):
        BaseAgent(config={"context": {"user_id": "u", "conversation_id": "   "}})


def test_base_agent_attach_tools_no_config_tools_returns_empty(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    agent = BaseAgent()
    agent.attach_tools([_NamedTool("search")])
    assert agent.tools == []
    assert agent.tools_names == []


def test_base_agent_attach_tools_filters_and_dedups(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    get_tool_cache_key = agents_service.mcp_tools.get_tool_cache_key

    agent = BaseAgent(
        config={"tools": [{"tool_name": "fetch"}, {"tool_name": "missing_tool"}]}
    )

    wanted = _NamedTool("fetch")
    duplicate = _NamedTool("fetch")
    unrelated = _NamedTool("other")

    # Confirm the cache key of our stand-in matches the configured key.
    assert get_tool_cache_key(wanted) == "fetch"

    agent.attach_tools([wanted, duplicate, unrelated])

    assert agent.tools == [wanted]
    assert agent.tools_names == ["fetch"]


def test_base_agent_encode_run_error(agents_service):
    BaseAgent = agents_service.base_agent.BaseAgent
    frame = BaseAgent._encode_run_error(RuntimeError("boom"))
    assert frame.startswith(b"data: ")
    payload = json.loads(frame[len(b"data: ") : -2].decode("utf-8"))
    assert payload["type"] == "RUN_ERROR"
