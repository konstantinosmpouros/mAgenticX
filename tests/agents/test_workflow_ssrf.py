"""Workflow engine — the ``fetch`` node's SSRF guard and bounds.

Pins: every non-public range is blocked (cloud metadata and IPv6 forms that
embed IPv4 included); a host is refused when *any* address it resolves to is
non-public; the request goes to the checked address with ``Host`` / SNI kept;
redirects are re-checked per hop and capped at 3; responses over 1 MiB are
refused; credentials are dropped on a cross-origin redirect.
"""
from __future__ import annotations

import importlib
import ipaddress
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError

PUBLIC_IP = "93.184.216.34"


@pytest.fixture
def wf(agents_service):
    return SimpleNamespace(
        ssrf=importlib.import_module("harness.workflows.ssrf"),
        fetch=importlib.import_module("harness.workflows.nodes.fetch"),
        base=importlib.import_module("harness.workflows.nodes.base"),
        spec=importlib.import_module("harness.workflows.spec"),
        errors=importlib.import_module("harness.workflows.errors"),
    )


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",  # cloud metadata
        "100.64.0.1",  # CGNAT
        "100.100.100.200",  # Alibaba metadata, inside CGNAT
        "0.0.0.0",
        "224.0.0.1",
        "240.0.0.1",
        "198.18.0.1",
        "::1",
        "::",
        "fe80::1",
        "fd00:ec2::254",  # AWS IPv6 metadata (ULA)
        "::ffff:127.0.0.1",  # IPv4-mapped loopback
        "::ffff:169.254.169.254",
        "64:ff9b::a00:1",  # NAT64 of 10.0.0.1
        "2002:0a00:0001::1",  # 6to4 of 10.0.0.1
        "ff02::1",
    ],
)
def test_non_public_addresses_are_blocked(wf, address):
    assert wf.ssrf.is_blocked_address(ipaddress.ip_address(address)) is True


@pytest.mark.parametrize("address", [PUBLIC_IP, "1.1.1.1", "2606:4700:4700::1111"])
def test_public_addresses_pass(wf, address):
    assert wf.ssrf.is_blocked_address(ipaddress.ip_address(address)) is False


@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "gopher://a.example/", "ftp://a.example/", "https://user:pw@a.example/", "https:///nohost"],
)
@pytest.mark.asyncio
async def test_bad_urls_are_refused_before_resolution(wf, monkeypatch, url):
    async def _never(host, port):
        raise AssertionError("must not resolve")

    monkeypatch.setattr(wf.ssrf, "resolve_host", _never)
    with pytest.raises(wf.ssrf.SSRFBlocked):
        await wf.ssrf.resolve_target(url)


@pytest.mark.asyncio
async def test_a_host_with_any_private_answer_is_refused(wf, monkeypatch):
    async def _mixed(host, port):
        return [PUBLIC_IP, "10.0.0.7"]

    monkeypatch.setattr(wf.ssrf, "resolve_host", _mixed)
    with pytest.raises(wf.ssrf.SSRFBlocked):
        await wf.ssrf.resolve_target("https://rebind.example/")


@pytest.mark.asyncio
async def test_literal_ips_and_localhost_are_checked(wf):
    for url in ("http://127.0.0.1:8002/health", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"):
        with pytest.raises(wf.ssrf.SSRFBlocked):
            await wf.ssrf.resolve_target(url)


# -- the fetch node over a mock transport --------------------------------------


class _Client:
    """Routes the node's client to a handler; records every request."""

    def __init__(self, handler):
        self.requests: list[httpx.Request] = []

        def record(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            return handler(request)

        self.transport = httpx.MockTransport(record)

    def factory(self, timeout_seconds):
        return httpx.AsyncClient(transport=self.transport, follow_redirects=False, trust_env=False)


def _resolver(mapping: dict[str, str]):
    async def resolve(host, port):
        return [mapping.get(host, PUBLIC_IP)]

    return resolve


async def _run_fetch(wf, config):
    spec = wf.spec.WorkflowSpec.model_validate(
        {"version": 1, "name": "t", "nodes": [{"id": "start", "kind": "trigger.manual"}]}
    )
    node = wf.fetch.FetchNode(wf.spec.NodeSpec(id="f", kind="fetch", config=config), spec)
    ctx = wf.base.NodeContext(
        node_id="f", execution_id="f#1", iteration=1, parent_execution_id=None,
        run=wf.base.RunInfo("r", "t", "u", "w", 1), config=node.config, scope={}, emitter=None, writer=None,
    )
    return await node.run({}, ctx)


@pytest.mark.asyncio
async def test_request_is_pinned_to_the_checked_address(wf, monkeypatch):
    client = _Client(lambda r: httpx.Response(200, json={"ok": True}))
    monkeypatch.setattr(wf.fetch, "make_client", client.factory)
    monkeypatch.setattr(wf.ssrf, "resolve_host", _resolver({}))
    result = await _run_fetch(wf, {"url": "https://api.example/v1?a=1", "query": {"b": True}})
    sent = client.requests[0]
    assert sent.url.host == PUBLIC_IP
    assert sent.headers["host"] == "api.example"
    assert sent.extensions.get("sni_hostname") == "api.example"
    assert result.output == {
        "status": 200, "ok": True, "url": "https://api.example/v1?a=1&b=true",
        "contentType": "application/json", "body": {"ok": True},
    }


@pytest.mark.asyncio
async def test_a_redirect_to_a_private_address_is_blocked(wf, monkeypatch):
    def handler(request):
        if request.headers["host"] == "public.example":
            return httpx.Response(302, headers={"location": "http://internal.example/admin"})
        return httpx.Response(200, text="secret")

    client = _Client(handler)
    monkeypatch.setattr(wf.fetch, "make_client", client.factory)
    monkeypatch.setattr(wf.ssrf, "resolve_host", _resolver({"internal.example": "10.0.0.5"}))
    with pytest.raises(wf.ssrf.SSRFBlocked):
        await _run_fetch(wf, {"url": "http://public.example/"})
    assert len(client.requests) == 1  # the private hop was never sent


@pytest.mark.asyncio
async def test_redirects_are_capped_at_three(wf, monkeypatch):
    client = _Client(lambda r: httpx.Response(302, headers={"location": "/again"}))
    monkeypatch.setattr(wf.fetch, "make_client", client.factory)
    monkeypatch.setattr(wf.ssrf, "resolve_host", _resolver({}))
    with pytest.raises(wf.errors.NodeExecutionError) as caught:
        await _run_fetch(wf, {"url": "https://loop.example/"})
    assert caught.value.code == "fetch_redirects"
    assert len(client.requests) == 4  # the original + 3 followed redirects


@pytest.mark.asyncio
async def test_credentials_are_dropped_on_a_cross_origin_redirect(wf, monkeypatch):
    def handler(request):
        if request.headers["host"] == "a.example":
            return httpx.Response(307, headers={"location": "https://b.example/next"})
        return httpx.Response(200, text="ok")

    client = _Client(handler)
    monkeypatch.setattr(wf.fetch, "make_client", client.factory)
    monkeypatch.setattr(wf.ssrf, "resolve_host", _resolver({}))
    result = await _run_fetch(wf, {"url": "https://a.example/", "headers": {"Authorization": "Bearer t", "X-Trace": "1"}})
    first, second = client.requests
    assert first.headers.get("authorization") == "Bearer t"
    assert "authorization" not in second.headers and second.headers.get("x-trace") == "1"
    assert result.output["body"] == "ok" and result.output["url"] == "https://b.example/next"


@pytest.mark.asyncio
async def test_303_turns_a_post_into_a_get(wf, monkeypatch):
    def handler(request):
        if request.url.path == "/submit":
            return httpx.Response(303, headers={"location": "/result"})
        return httpx.Response(200, json={"method": request.method})

    client = _Client(handler)
    monkeypatch.setattr(wf.fetch, "make_client", client.factory)
    monkeypatch.setattr(wf.ssrf, "resolve_host", _resolver({}))
    result = await _run_fetch(wf, {"method": "POST", "url": "https://a.example/submit", "body": {"x": 1}})
    assert result.output["body"] == {"method": "GET"}
    assert client.requests[0].content == b'{"x":1}' or client.requests[0].content == b'{"x": 1}'


@pytest.mark.asyncio
async def test_responses_over_one_mebibyte_are_refused(wf, monkeypatch):
    big = b"x" * (1024 * 1024 + 1)
    client = _Client(lambda r: httpx.Response(200, content=big))
    monkeypatch.setattr(wf.fetch, "make_client", client.factory)
    monkeypatch.setattr(wf.ssrf, "resolve_host", _resolver({}))
    with pytest.raises(wf.errors.NodeExecutionError) as caught:
        await _run_fetch(wf, {"url": "https://big.example/"})
    assert caught.value.code == "fetch_too_large"


def test_fetch_config_bounds(wf):
    Config = wf.fetch.FetchConfig
    with pytest.raises(ValidationError):
        Config(url="https://a.example", timeout_seconds=31)
    with pytest.raises(ValidationError):
        Config(url="https://a.example", headers={"Host": "internal"})
    with pytest.raises(ValidationError):
        Config(url="https://a.example", headers={"X-A": "1\r\nX-B: 2"})
    with pytest.raises(ValidationError):
        Config(url="https://a.example", method="DELETE")
