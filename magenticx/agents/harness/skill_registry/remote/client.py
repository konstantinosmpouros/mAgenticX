"""The one HTTP client remote skill sources are reached through.

Everything outbound for plan 30 goes through :class:`RemoteSkillClient`, so the
rules that make it safe hold in one place:

* **Host allowlist on every hop.** Redirects are followed by hand, and each
  ``Location`` is checked against :data:`sources.ALLOWED_HOSTS` before it is
  requested. httpx's own redirect following would happily leave the allowlist.
* **A byte ceiling on every body**, enforced while streaming, so a hostile or
  broken upstream cannot make the process buffer without bound.
* **Timeouts on every call** (connect + read), from settings.
* **No credentials.** The design needs at most four REST calls a day, far
  inside GitHub's anonymous allowance, so no token exists to leak.

The HEAD check deliberately avoids the REST API: an anonymous conditional
request still costs quota even when GitHub answers ``304`` (measured 46 → 45 →
44), while git's smart-HTTP ref advertisement costs none.
"""
from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import quote, urljoin

import httpx

from core.logging import get_logger
from core.settings import settings
from harness.skill_registry.remote.sources import (
    MAX_REFS_BYTES,
    MAX_TREE_BYTES,
    is_allowed_url,
)

logger = get_logger(__name__)

_USER_AGENT = "magenticx-skill-sync"
_MAX_REDIRECTS = 3
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})


class RemoteFetchError(RuntimeError):
    """An outbound read failed. ``reason`` is a short, log-safe code."""

    def __init__(self, reason: str, url: str = "") -> None:
        super().__init__(f"{reason}: {url}" if url else reason)
        self.reason = reason
        self.url = url


class HostNotAllowed(RemoteFetchError):
    """A request or a redirect pointed outside the allowlist."""


class BodyTooLarge(RemoteFetchError):
    """A response exceeded the ceiling set for it."""


class TreeTruncated(RemoteFetchError):
    """GitHub returned a partial tree — the source cannot be synced safely."""


def _timeout() -> httpx.Timeout:
    cfg = settings.remote_skills
    return httpx.Timeout(
        connect=cfg.connect_timeout_seconds,
        read=cfg.read_timeout_seconds,
        write=cfg.read_timeout_seconds,
        pool=cfg.connect_timeout_seconds,
    )


def parse_ref_advertisement(body: bytes, branch: str) -> Optional[str]:
    """The commit SHA of ``refs/heads/<branch>`` from a git ``info/refs`` body.

    The body is a sequence of pkt-lines: four hex digits of length (including
    themselves), then the payload; ``0000`` is a flush. The first ref line
    carries the capability list after a NUL, which is stripped.
    """
    want = f"refs/heads/{branch}".encode()
    pos = 0
    while pos + 4 <= len(body):
        try:
            length = int(body[pos:pos + 4], 16)
        except ValueError:
            return None
        if length == 0:
            pos += 4
            continue
        if length < 4 or pos + length > len(body):
            return None
        line = body[pos + 4:pos + length].rstrip(b"\n").split(b"\x00", 1)[0]
        pos += length
        sha, _, ref = line.partition(b" ")
        if ref == want and len(sha) == 40:
            try:
                int(sha, 16)
            except ValueError:
                return None
            return sha.decode("ascii")
    return None


class RemoteSkillClient:
    """Allowlisted, capped, timed-out GETs. Use as an async context manager.

    ``transport`` is injectable so tests can serve fixtures through
    ``httpx.MockTransport`` with no network at all.
    """

    def __init__(self, transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        self._client = httpx.AsyncClient(
            timeout=_timeout(),
            follow_redirects=False,
            headers={"User-Agent": _USER_AGENT},
            transport=transport,
        )

    async def __aenter__(self) -> "RemoteSkillClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self._client.aclose()

    async def get_bytes(
        self, url: str, *, max_bytes: int, accept: Optional[str] = None
    ) -> bytes:
        """GET ``url``, following allowlisted redirects, refusing oversized bodies."""
        headers = {"Accept": accept} if accept else None
        current = url
        for _ in range(_MAX_REDIRECTS + 1):
            if not is_allowed_url(current):
                raise HostNotAllowed("host not allowed", current)
            try:
                async with self._client.stream("GET", current, headers=headers) as resp:
                    if resp.status_code in _REDIRECT_CODES:
                        location = resp.headers.get("location")
                        if not location:
                            raise RemoteFetchError("redirect without location", current)
                        current = urljoin(current, location)
                        continue
                    if resp.status_code != 200:
                        raise RemoteFetchError(f"http {resp.status_code}", current)
                    declared = resp.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > max_bytes:
                        raise BodyTooLarge("body too large", current)
                    chunks: list[bytes] = []
                    received = 0
                    async for chunk in resp.aiter_bytes():
                        received += len(chunk)
                        if received > max_bytes:
                            raise BodyTooLarge("body too large", current)
                        chunks.append(chunk)
                    return b"".join(chunks)
            except httpx.TimeoutException as exc:
                raise RemoteFetchError("timeout", current) from exc
            except httpx.HTTPError as exc:
                raise RemoteFetchError("transport error", current) from exc
        raise RemoteFetchError("too many redirects", url)

    async def get_json(self, url: str, *, max_bytes: int, accept: Optional[str] = None) -> Any:
        body = await self.get_bytes(url, max_bytes=max_bytes, accept=accept)
        try:
            return json.loads(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise RemoteFetchError("malformed json", url) from exc

    # -- GitHub ------------------------------------------------------------
    async def head_commit(self, repo: str, branch: str) -> str:
        """The branch's current commit, read without spending REST quota."""
        url = f"https://github.com/{repo}.git/info/refs?service=git-upload-pack"
        body = await self.get_bytes(url, max_bytes=MAX_REFS_BYTES)
        sha = parse_ref_advertisement(body, branch)
        if sha is None:
            raise RemoteFetchError("branch not advertised", url)
        return sha

    async def tree(self, repo: str, commit: str) -> list[dict[str, Any]]:
        """The whole recursive tree at ``commit`` — one REST call.

        A truncated tree raises rather than returning a partial list: syncing a
        partial tree would withdraw every skill that happened to be cut off.
        """
        url = f"https://api.github.com/repos/{repo}/git/trees/{commit}?recursive=1"
        data = await self.get_json(url, max_bytes=MAX_TREE_BYTES, accept="application/vnd.github+json")
        if not isinstance(data, dict) or not isinstance(data.get("tree"), list):
            raise RemoteFetchError("malformed tree", url)
        if data.get("truncated"):
            raise TreeTruncated("tree truncated", url)
        return data["tree"]

    async def raw(self, repo: str, commit: str, path: str, *, max_bytes: int) -> bytes:
        """One file at a pinned commit. ``raw.githubusercontent.com`` costs no REST quota."""
        url = f"https://raw.githubusercontent.com/{repo}/{commit}/{quote(path)}"
        return await self.get_bytes(url, max_bytes=max_bytes)


__all__ = [
    "BodyTooLarge",
    "HostNotAllowed",
    "RemoteFetchError",
    "RemoteSkillClient",
    "TreeTruncated",
    "parse_ref_advertisement",
]
