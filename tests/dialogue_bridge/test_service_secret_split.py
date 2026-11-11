"""Two secrets, two meanings (review finding 7, 2026-11-11).

``TRUSTED_PROXY_SECRET`` is what the UI's nginx sends on every browser request:
it only says "this came through the edge proxy", so the forwarded client IP can
be trusted. ``INTERNAL_SERVICE_SECRET`` is the credential between services
(bridge, agents, rag_service, the sandbox runner). The UI never holds it, so a
browser request, or a compromised UI container, can never pass as a service.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import SecretStr, ValidationError
from starlette.requests import Request

from core.security.internal_trust import (
    TRUSTED_PROXY_HEADER_NAME,
    internal_service_headers,
    is_internal_service_request,
    is_trusted_proxy_request,
    resolve_client_ip,
)
from core.settings import AppSettings, ProxySettings, Settings, settings

REPO_ROOT = Path(__file__).resolve().parents[2]
PROXY = settings.proxy.secret.get_secret_value()
SERVICE = settings.proxy.internal_secret.get_secret_value()


def _request(secret: str | None, *, forwarded: str | None = None) -> Request:
    headers = []
    if secret is not None:
        headers.append((TRUSTED_PROXY_HEADER_NAME.lower().encode(), secret.encode()))
    if forwarded:
        headers.append((b"cf-connecting-ip", forwarded.encode()))
    return Request({"type": "http", "headers": headers, "client": ("10.0.0.7", 1234)})


def test_the_two_secrets_differ_in_the_suite():
    assert PROXY and SERVICE and PROXY != SERVICE


def test_only_the_service_secret_makes_a_service():
    assert is_internal_service_request(_request(SERVICE)) is True
    assert is_internal_service_request(_request(PROXY)) is False  # what nginx sends
    assert is_internal_service_request(_request(None)) is False


def test_only_the_proxy_secret_trusts_the_forwarded_ip():
    assert resolve_client_ip(_request(PROXY, forwarded="203.0.113.5")) == "203.0.113.5"
    assert resolve_client_ip(_request(SERVICE, forwarded="203.0.113.5")) == "10.0.0.7"
    assert is_trusted_proxy_request(_request(SERVICE)) is False


def test_calls_to_other_services_carry_the_service_secret():
    assert internal_service_headers()[TRUSTED_PROXY_HEADER_NAME] == SERVICE


async def test_an_internal_route_refuses_what_nginx_sends(client):
    url = "/v1/internal/conversations/conv-x/input-files"
    browser = await client.get(url, headers={TRUSTED_PROXY_HEADER_NAME: PROXY})
    assert browser.status_code == 403
    service = await client.get(url, headers={TRUSTED_PROXY_HEADER_NAME: SERVICE})
    assert service.status_code != 403


@pytest.mark.parametrize("proxy, internal, message", [
    ("p", "", "INTERNAL_SERVICE_SECRET must be set"),
    ("same", "same", "INTERNAL_SERVICE_SECRET must differ from TRUSTED_PROXY_SECRET"),
])
def test_the_bridge_refuses_to_start_without_a_separate_service_secret(monkeypatch, proxy, internal, message):
    monkeypatch.delenv("INTERNAL_SERVICE_SECRET", raising=False)
    monkeypatch.delenv("INTERNAL_SERVICE_SECRET_FILE", raising=False)
    with pytest.raises(ValidationError, match=message):
        Settings(
            app=AppSettings(_env_file=None, APP_ENV="test"),
            proxy=ProxySettings(_env_file=None, secret=SecretStr(proxy), internal_secret=SecretStr(internal)),
        )


def _service_block(compose: str, name: str) -> str:
    start = compose.index(f"\n  {name}:")
    nxt = [compose.find(f"\n  {other}:", start + 1) for other in
           ("vectordb", "rag_service", "agents", "chat_postgres", "redis", "dialogue_bridge", "agentic_ui", "backend")]
    return compose[start:min(i for i in nxt if i > start)]


@pytest.mark.parametrize("compose_file", ["docker-compose-denis.yaml", "docker-compose.yaml"])
def test_the_ui_never_gets_the_service_secret_and_services_never_get_the_proxy_secret(compose_file):
    compose = (REPO_ROOT / "magenticx" / compose_file).read_text(encoding="utf-8")
    ui = _service_block(compose, "agentic_ui")
    assert "INTERNAL_SERVICE_SECRET" not in ui and "internal_service_secret" not in ui
    for service in ("agents", "rag_service"):
        block = _service_block(compose, service)
        assert "INTERNAL_SERVICE_SECRET" in block
        assert "TRUSTED_PROXY_SECRET" not in block and "trusted_proxy_secret" not in block
    bridge = _service_block(compose, "dialogue_bridge")
    assert "TRUSTED_PROXY_SECRET" in bridge and "INTERNAL_SERVICE_SECRET" in bridge
