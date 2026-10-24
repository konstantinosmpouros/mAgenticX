"""``/conversation/input/`` — the user's uploads, read where they already live.

The uploads are the bridge's attachments in ``chat_db``; the bridge validated
them, caps them, and shares, forks and exports them. So nothing is copied here:
the bridge lists every upload of the conversation — every turn, every branch —
under the stable name it gave the file at upload (``attachments.workspace_name``),
and serves the bytes on demand. A file from the first turn is as readable on
the fiftieth as it was then, under the name the history shows.

The list is fetched once per run (uploads only arrive with a new user message,
which is a new run). Bytes are cached process-wide by content hash: content
never changes under a hash, so the cache can never serve a stale file, and an
entry is only ever handed to a run whose own (ownership-checked) list names it.

The bridge being unreachable is not a failed run: the reads that need it say
the uploads are temporarily unavailable, and everything else carries on.
"""
from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import httpx

from core.logging import get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings

logger = get_logger(__name__)

UNAVAILABLE_MESSAGE = (
    "The user's uploaded files are temporarily unavailable. Carry on without "
    "them, or try again shortly."
)


class InputsUnavailable(Exception):
    """The uploads exist, but the bridge could not hand them over just now."""


@dataclass(frozen=True)
class InputFile:
    """One upload as the agent sees it: ``/conversation/input/<name>``."""

    name: str
    attachment_id: str
    size: int
    sha256: str
    created_at: str


class _ByteCache:
    """A least-recently-used cache of upload bytes, bounded in total size."""

    def __init__(self) -> None:
        self._entries: OrderedDict[tuple[str, str], bytes] = OrderedDict()
        self._size = 0

    def get(self, key: tuple[str, str]) -> bytes | None:
        data = self._entries.get(key)
        if data is not None:
            self._entries.move_to_end(key)
        return data

    def put(self, key: tuple[str, str], data: bytes) -> None:
        budget = settings.conversation_files.input_cache_bytes
        if key in self._entries or len(data) > budget:
            return
        self._entries[key] = data
        self._size += len(data)
        while self._size > budget:
            _, evicted = self._entries.popitem(last=False)
            self._size -= len(evicted)

    def clear(self) -> None:
        self._entries.clear()
        self._size = 0


_cache = _ByteCache()


async def _bridge_get(path: str, params: dict[str, str]) -> httpx.Response:
    """One internal GET to the bridge (mTLS + trusted-proxy header)."""
    timeout = httpx.Timeout(
        settings.bridge.request_timeout_seconds, connect=settings.bridge.connect_timeout_seconds
    )
    async with httpx.AsyncClient(
        timeout=timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    ) as client:
        return await client.get(
            f"{settings.bridge.conversations_url}{path}",
            params=params,
            headers=internal_service_headers(),
        )


def _input_file(item: dict[str, Any]) -> InputFile:
    return InputFile(
        name=str(item["name"]),
        attachment_id=str(item["attachment_id"]),
        size=int(item["size"]),
        sha256=str(item["sha256"]),
        created_at=str(item.get("created_at") or ""),
    )


class InputView:
    """One run's read-only view of its conversation's uploads."""

    def __init__(self, user_id: str, conversation_id: str) -> None:
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._files: dict[str, InputFile] | None = None

    async def files(self) -> dict[str, InputFile]:
        """Every upload by name. Fetched on first use, then kept for the run."""
        if self._files is not None:
            return self._files
        started = time.monotonic()
        try:
            response = await _bridge_get(
                f"/{self._conversation_id}/input-files", {"user_id": self._user_id}
            )
            if response.status_code == httpx.codes.NOT_FOUND:
                # A bridge that predates the endpoint, or a conversation it no
                # longer has: either way there is nothing to read.
                logger.warning("conversation_input_manifest_unavailable",
                               "The bridge listed no uploads for this conversation", status=404)
                self._files = {}
                return self._files
            response.raise_for_status()
            items = response.json().get("files", [])
            files = {entry.name: entry for entry in map(_input_file, items)}
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError) as exc:
            logger.warning("conversation_input_fetch_failed", "Could not list the conversation's uploads",
                           error_type=type(exc).__name__)
            raise InputsUnavailable from exc
        self._files = files
        logger.info("conversation_input_manifest_fetched", "Listed the conversation's uploads",
                    files=len(files), duration_ms=round((time.monotonic() - started) * 1000))
        return files

    async def read(self, name: str) -> bytes | None:
        """The bytes of one upload, or None when there is no upload by that name."""
        entry = (await self.files()).get(name)
        if entry is None:
            return None
        key = (self._user_id, entry.sha256)
        cached = _cache.get(key)
        if cached is not None:
            logger.debug("conversation_input_fetched", "Read an upload", bytes=len(cached), cache_hit=True)
            return cached
        started = time.monotonic()
        try:
            response = await _bridge_get(
                f"/{self._conversation_id}/input-files/{entry.attachment_id}", {"user_id": self._user_id}
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            logger.warning("conversation_input_fetch_failed", "Could not read an upload",
                           status=status, error_type=type(exc).__name__)
            raise InputsUnavailable from exc
        data = response.content
        if hashlib.sha256(data).hexdigest() != entry.sha256:
            logger.warning("conversation_input_fetch_failed", "An upload did not match its hash",
                           error_type="sha256_mismatch")
            raise InputsUnavailable
        _cache.put(key, data)
        logger.debug("conversation_input_fetched", "Read an upload", bytes=len(data), cache_hit=False,
                     duration_ms=round((time.monotonic() - started) * 1000))
        return data
