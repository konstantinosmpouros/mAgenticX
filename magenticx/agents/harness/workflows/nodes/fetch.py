"""``fetch`` — one HTTP GET or POST to a public URL.

Bounded on every axis: ``http``/``https`` only, every hop through the SSRF
guard (``harness/workflows/ssrf.py`` — resolve, refuse non-public addresses,
connect to the checked address), at most 3 redirects followed by hand, a
timeout of at most 30 s for the whole exchange, and a 1 MiB response cap read
as a stream (a larger body is refused, not truncated). A non-2xx status is not
a failure — it is data, for a ``condition`` to test.

Output: ``{"status", "ok", "url", "contentType", "body"}`` where ``body`` is
parsed JSON or text per ``response_type`` and ``url`` (the final one) has its
credential-looking query values masked.

The run stores and shows every execution's resolved config
(``workflow.node_input``); :meth:`FetchNode.input_view` masks the credentials
in it — header and query values whose name looks secret (``Authorization``,
``Cookie``, ``X-Api-Key``, ``access_token`` …) and the URL's userinfo.

Nothing about the request or response is logged: URLs carry tokens in query
strings often enough that only the outcome code is.
"""
from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Mapping
from typing import Any, Literal
from urllib.parse import unquote_plus, urljoin

import httpx
from pydantic import Field, field_validator

from harness.workflows import ssrf
from harness.workflows.errors import NodeExecutionError
from harness.workflows.nodes.base import NodeConfig, NodeContext, NodeResult, WorkflowNode

MAX_REDIRECTS = 3
MAX_TIMEOUT_SECONDS = 30.0
MAX_RESPONSE_BYTES = 1024 * 1024
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
#: Headers the caller may not set: the guard owns routing (``Host``) and httpx
#: owns framing.
FORBIDDEN_HEADERS = frozenset({"host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer"})
#: Dropped when a redirect leaves the original origin.
CREDENTIAL_HEADERS = frozenset({"authorization", "cookie", "proxy-authorization"})
_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$")
#: A header or query parameter whose name contains one of these carries a
#: credential: its value is masked in what the run stores and shows.
SECRET_NAME_PARTS = ("authorization", "cookie", "token", "secret", "key", "password", "passwd", "auth", "session", "credential", "signature")
MASK = "••••••"
#: ``scheme://user:pass@`` — the userinfo of a URL, up to its ``@``.
_USERINFO = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#@]*@")


def is_secret_name(name: str) -> bool:
    """Whether a header / query parameter name looks like it carries a credential."""
    lowered = name.lower()
    return any(part in lowered for part in SECRET_NAME_PARTS)


def mask_url(url: str) -> str:
    """The URL with credential-looking query values and any userinfo masked.

    Works on the text, not a parsed URL, so it never fails and the mask is not
    percent-encoded; every other byte of the URL is kept as written.
    """
    masked = _USERINFO.sub(r"\1" + MASK + "@", url, count=1)
    head, sep, rest = masked.partition("?")
    if not sep:
        return masked
    query, hash_sep, fragment = rest.partition("#")
    pairs = []
    for pair in query.split("&"):
        name, eq, _value = pair.partition("=")
        pairs.append(f"{name}={MASK}" if eq and is_secret_name(unquote_plus(name)) else pair)
    return f"{head}?{'&'.join(pairs)}{hash_sep}{fragment}"


class FetchConfig(NodeConfig):
    """One request."""

    method: Literal["GET", "POST"] = "GET"
    url: str = Field(min_length=1, max_length=2048, description="http(s) URL; templates allowed")
    headers: dict[str, str] = Field(default_factory=dict, max_length=32)
    query: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=32)
    body: Any = Field(default=None, description="JSON body (POST only)")
    timeout_seconds: float = Field(default=15.0, gt=0, le=MAX_TIMEOUT_SECONDS)
    response_type: Literal["auto", "json", "text"] = "auto"

    @field_validator("headers")
    @classmethod
    def _headers_allowed(cls, value: dict[str, str]) -> dict[str, str]:
        for name, header_value in value.items():
            if not _HEADER_NAME.match(name):
                raise ValueError(f"'{name}' is not a valid header name.")
            if name.lower() in FORBIDDEN_HEADERS:
                raise ValueError(f"The '{name}' header cannot be set.")
            if "\r" in header_value or "\n" in header_value:
                raise ValueError(f"The '{name}' header value contains a line break.")
        return value


def make_client(timeout_seconds: float) -> httpx.AsyncClient:
    """The HTTP client of one fetch. Module-level so tests can mount a transport.

    ``trust_env=False``: an environment proxy would make the connection go
    somewhere other than the address the guard checked.
    """
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout_seconds),
        follow_redirects=False,
        trust_env=False,
    )


def _query_value(value: str | int | float | bool) -> str:
    """A query parameter as text; booleans as ``true``/``false``."""
    return str(value).lower() if isinstance(value, bool) else str(value)


def _pinned(url: httpx.URL, target: ssrf.Target) -> tuple[httpx.URL, dict[str, str], dict[str, Any]]:
    """The URL rewritten to the checked address, plus the ``Host`` header and
    the TLS SNI extension that keep the original name."""
    pinned = url.copy_with(host=target.addresses[0])
    host_header = target.host if url.port is None else f"{target.host}:{url.port}"
    extensions = {"sni_hostname": target.host} if target.scheme == "https" else {}
    return pinned, {"Host": host_header}, extensions


def _parse_body(raw: bytes, content_type: str, encoding: str | None, mode: str) -> Any:
    """JSON or text, per ``response_type``."""
    text = raw.decode(encoding or "utf-8", errors="replace")
    wants_json = mode == "json" or (mode == "auto" and "json" in content_type.lower())
    if not wants_json:
        return text
    try:
        return json.loads(text) if text else None
    except ValueError as exc:
        if mode == "json":
            raise NodeExecutionError("The response is not valid JSON.", code="fetch_parse") from exc
        return text


async def _read_capped(response: httpx.Response) -> bytes:
    """The body, refusing past ``MAX_RESPONSE_BYTES`` instead of buffering it all."""
    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_RESPONSE_BYTES:
        raise NodeExecutionError("The response is larger than 1 MiB.", code="fetch_too_large")
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise NodeExecutionError("The response is larger than 1 MiB.", code="fetch_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


class FetchNode(WorkflowNode):
    """HTTP request node."""

    kind = "fetch"
    label = "HTTP request"
    group = "data"
    description = "GET or POST a public http(s) URL (SSRF-guarded, ≤3 redirects, ≤30 s, ≤1 MiB)."
    Config = FetchConfig

    def input_view(self, rendered: dict[str, Any]) -> dict[str, Any]:
        """Credentials masked: header and query values with a secret-looking
        name, and the URL's userinfo and secret query values. The run's events
        are stored and shown; the request itself is sent with the real values."""
        view = dict(rendered)
        if isinstance(view.get("headers"), Mapping):
            view["headers"] = {k: MASK if is_secret_name(str(k)) else v for k, v in view["headers"].items()}
        if isinstance(view.get("query"), Mapping):
            view["query"] = {k: MASK if is_secret_name(str(k)) else v for k, v in view["query"].items()}
        if isinstance(view.get("url"), str):
            view["url"] = mask_url(view["url"])
        return view

    async def run(self, state: Mapping[str, Any], ctx: NodeContext) -> NodeResult:
        cfg: FetchConfig = ctx.config
        if cfg.method == "GET" and cfg.body is not None:
            raise NodeExecutionError("A GET request cannot have a body.", code="fetch_config")
        try:
            async with asyncio.timeout(cfg.timeout_seconds):
                return await self._exchange(cfg)
        except TimeoutError as exc:
            raise NodeExecutionError("The request timed out.", code="fetch_timeout") from exc
        except httpx.HTTPError as exc:
            raise NodeExecutionError(f"The request failed ({type(exc).__name__}).", code="fetch_failed") from exc

    async def _exchange(self, cfg: FetchConfig) -> NodeResult:
        """Send, following up to ``MAX_REDIRECTS`` redirects through the guard."""
        try:
            url = httpx.URL(cfg.url)
            if cfg.query:
                url = url.copy_merge_params({key: _query_value(value) for key, value in cfg.query.items()})
        except (httpx.InvalidURL, TypeError, ValueError) as exc:
            raise ssrf.SSRFBlocked("The URL is malformed.") from exc
        method = cfg.method
        body = cfg.body
        # A templated value can end in whitespace (``Bearer {{input.token}}``
        # with an empty token), which h11 rejects as an illegal header value:
        # trim every value and drop the ones left empty.
        headers = {key: value.strip() for key, value in cfg.headers.items() if value.strip()}
        origin = None
        async with make_client(cfg.timeout_seconds) as client:
            for hop in range(MAX_REDIRECTS + 1):
                target = await ssrf.resolve_target(str(url))
                if origin is None:
                    origin = (target.scheme, target.host, target.port)
                elif origin != (target.scheme, target.host, target.port):
                    headers = {k: v for k, v in headers.items() if k.lower() not in CREDENTIAL_HEADERS}
                pinned, host_header, extensions = _pinned(url, target)
                request = client.build_request(
                    method,
                    pinned,
                    headers={**headers, **host_header},
                    json=body if method == "POST" else None,
                    extensions=extensions,
                )
                response = await client.send(request, stream=True)
                try:
                    location = response.headers.get("location")
                    if response.status_code in REDIRECT_STATUSES and location:
                        if hop == MAX_REDIRECTS:
                            raise NodeExecutionError("Too many redirects (max 3).", code="fetch_redirects")
                        url = httpx.URL(urljoin(str(url), location))
                        if response.status_code == 303 or (response.status_code in (301, 302) and method == "POST"):
                            method, body = "GET", None
                        continue
                    raw = await _read_capped(response)
                    content_type = response.headers.get("content-type", "")
                    return NodeResult(
                        output={
                            "status": response.status_code,
                            "ok": 200 <= response.status_code < 300,
                            # Masked: the output is stored and shown, and a
                            # later step has no use for the credential.
                            "url": mask_url(str(url)),
                            "contentType": content_type,
                            "body": _parse_body(raw, content_type, response.encoding, cfg.response_type),
                        }
                    )
                finally:
                    await response.aclose()
        raise NodeExecutionError("Too many redirects (max 3).", code="fetch_redirects")
