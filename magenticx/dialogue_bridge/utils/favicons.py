"""Site icons for the source chips (plan 42).

A search step's sources are shown as small chips with the site's icon — the
icon of the page's browser tab. The icons are fetched here, not in the browser:

* **No SSRF surface.** The bridge never connects to an address taken from a
  search result. It asks fixed https icon services (``FAVICON_SERVICE_URLS``,
  DuckDuckGo then Google) for the hostname's icon; the hostname is validated
  first and never contains an IP literal, a port, credentials or a path. Only
  the hostname reaches them — never the page, the user or the conversation.
* **No tracking.** The browser loads the icon from our own origin, so no third
  party (and no site) learns which pages the user's agent read.
* **Untrusted bytes.** Only small raster images are passed on (no SVG, which
  could carry script), with ``nosniff`` and a sandboxing CSP on the response.

Icons are cached in Redis per hostname (``favicon:{host}``), and a host with no
icon is remembered for a day, so a chip costs at most one upstream call a week.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
from dataclasses import dataclass

import httpx
import redis.asyncio as aioredis
from redis.exceptions import RedisError

from core.cache.client import create_redis_client
from core.logging import get_logger
from core.settings import settings

logger = get_logger(__name__)

#: A hostname: dot-separated labels and an alphabetic TLD — so never an IP
#: literal, ``localhost``, a port, credentials or a path.
_HOSTNAME = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")

#: The image types passed on. SVG is left out on purpose: it can carry script.
ALLOWED_TYPES = frozenset({
    "image/x-icon", "image/vnd.microsoft.icon", "image/png", "image/jpeg", "image/gif", "image/webp",
})

#: Cached value for a host that has no icon.
_MISS = "-"


@dataclass(frozen=True)
class Favicon:
    """One site icon, ready to serve."""

    content_type: str
    data: bytes


def normalise_host(raw: str) -> str | None:
    """The hostname to look up, or ``None`` when ``raw`` is not a plain public one.

    Lowercased, and an internationalised name turned into its ASCII form
    before validation.
    """
    host = (raw or "").strip().lower().rstrip(".")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    return host if _HOSTNAME.match(host) else None


def _key(host: str) -> str:
    return f"favicon:{host}"


class FaviconCache:
    """``favicon:{host}`` on one lazily created client."""

    def __init__(self) -> None:
        self._client: aioredis.Redis | None = None
        self._guard = asyncio.Lock()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        async with self._guard:
            if self._client is None:
                self._client = create_redis_client()
        return self._client

    async def get(self, host: str) -> Favicon | None | bool:
        """The cached icon, ``False`` for a remembered miss, ``None`` when unknown."""
        raw = await (await self._get_client()).get(_key(host))
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        if raw == _MISS:
            return False
        try:
            entry = json.loads(raw)
            return Favicon(content_type=entry["t"], data=base64.b64decode(entry["b"], validate=True))
        except (ValueError, KeyError, TypeError):
            return None

    async def put(self, host: str, icon: Favicon | None) -> None:
        """Remember the icon (a week) or that there is none (a day)."""
        client = await self._get_client()
        if icon is None:
            await client.set(_key(host), _MISS, ex=settings.favicons.miss_ttl_seconds)
            return
        value = json.dumps({"t": icon.content_type, "b": base64.b64encode(icon.data).decode("ascii")})
        await client.set(_key(host), value, ex=settings.favicons.cache_ttl_seconds)


favicon_cache = FaviconCache()


def _candidates(host: str) -> list[str]:
    """The hosts to ask about: as given, then its ``www.`` twin (icon services
    often know only one of the two)."""
    twin = host[4:] if host.startswith("www.") else f"www.{host}"
    return [host, twin] if _HOSTNAME.match(twin) else [host]


async def _fetch(host: str) -> Favicon | None:
    """The first usable icon any service has for ``host`` or its ``www.`` twin."""
    services = [url.strip() for url in settings.favicons.service_urls.split(",") if url.strip()]
    for service in services:
        for candidate in _candidates(host):
            icon = await _fetch_one(service.format(host=candidate))
            if icon is not None:
                return icon
    return None


async def _fetch_one(url: str) -> Favicon | None:
    """One icon service's answer for one host; ``None`` when it has none usable.

    Redirects are followed (a service may hand off to its own CDN): the URL is
    one of ours, never a search result's.
    """
    limit = settings.favicons.max_bytes
    try:
        async with (
            httpx.AsyncClient(
                timeout=settings.favicons.timeout_seconds, follow_redirects=True, max_redirects=3,
            ) as client,
            client.stream("GET", url, headers={"Accept": "image/*"}) as response,
        ):
            if response.status_code != 200:
                return None
            content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if content_type not in ALLOWED_TYPES:
                return None
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > limit:
                    return None
    except httpx.HTTPError as exc:
        logger.info("favicon_fetch_failed", "Could not fetch a site icon", error_type=type(exc).__name__)
        return None
    return Favicon(content_type=content_type, data=bytes(data)) if data else None


async def get_favicon(raw_host: str) -> Favicon | None:
    """The icon for ``raw_host``, from the cache or the icon service; ``None`` for none.

    Fail-open: Redis being down only means the icon is fetched again; the icon
    service being down means the chip shows its fallback initial.
    """
    host = normalise_host(raw_host)
    if host is None or not settings.favicons.enabled:
        return None
    try:
        cached = await favicon_cache.get(host)
    except RedisError:
        cached = None
    if cached is False:
        return None
    if isinstance(cached, Favicon):
        return cached
    icon = await _fetch(host)
    try:
        await favicon_cache.put(host, icon)
    except RedisError:
        logger.info("favicon_cache_failed", "Could not cache a site icon")
    return icon


__all__ = ["ALLOWED_TYPES", "Favicon", "FaviconCache", "favicon_cache", "get_favicon", "normalise_host"]
