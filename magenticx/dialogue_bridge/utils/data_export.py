"""Export my data (plan 27) — everything a user owns, as one streamed zip.

This is the one operation in the product that reads a user's whole history at
once, on a box (Dennis) whose 24 GB is shared by every stack. So it is built as
a **pipe, not a pile**: read a page of rows or a slice of a file, put it in the
archive, send it, drop it. Nothing is ever held whole — not in memory, not on
disk — and the cost of an export does not grow with the size of the account.

* **Rows** come in keyset pages of ``EXPORT_PAGE_ROWS``, each page one short
  query on its own short session — no transaction or connection is held between
  pages, and every query walks an index in order (no sort, no temp file).
* **Attachment bytes** come in ``EXPORT_CHUNK_BYTES`` slices (``substring``),
  the same way attachment downloads already work.
* **Custom agents and skills** live in the agents service; it streams its part
  as framed lines that are copied straight into the archive.
* **The archive** is built by :class:`utils.zip_stream.ZipStream`, which never
  holds more than the bytes just written, and is sent as it is built.
  ``manifest.json`` is written last, and the zip's directory after it — a
  download cut short is therefore not a valid zip, never a quietly partial one.

What protects the service, given that rate limiting fails open:

* a durable **cooldown** on ``users.last_export_at``, claimed atomically when
  the download starts and handed back if it fails, so a dropped connection does
  not lock the user out for the whole window;
* at most ``EXPORT_MAX_CONCURRENT`` exports at once, one per user;
* a wall-clock ceiling; and a **one-time download token** minted by a
  CSRF-protected POST, so another site cannot start an export on the user's
  cookies.

Never exported: session or refresh tokens, CSRF secrets, share-link tokens and
their snapshots, raw agent event logs, message embeddings, agent memories (the
user's choice), and the shared copies of remote skills (third-party content,
exported as references instead).
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, AsyncIterator, Callable, Optional

import anyio
import httpx
from fastapi import HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, update
from sqlalchemy.sql import Select

from core.database import (
    AttachmentTable,
    BlobTable,
    ConversationReportTable,
    ConversationShareTable,
    ConversationTable,
    MessageTable,
    MessageUsageTable,
    ScheduledTaskTable,
    SessionLocal,
    UserAgentToolPrefTable,
    UserPreferencesTable,
    UserTable,
)
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from utils.zip_stream import ZipStream, check_archive_path, safe_file_name

logger = get_logger(__name__)

_AGENTS_BASE_URL = settings.upstream.agents_service_url.rstrip("/")
_TOKEN_PURPOSE = "export"
#: NDJSON lines are gathered to about this size before each archive write, so a
#: page of small rows is one write rather than fifty.
_FLUSH_BYTES = 256 * 1024
#: Upstream archive paths the agents service may write — nothing else.
_UPSTREAM_PREFIXES = ("agents/", "skills/")
FORMAT_VERSION = 1


class ExportAborted(RuntimeError):
    """The export cannot finish. The stream is cut; the zip is left invalid."""


# ---------------------------------------------------------------------------
# What is exported, column by column
# ---------------------------------------------------------------------------
# Allowlists, not SELECT *: a column added to any of these tables later is NOT
# exported until someone adds it here — so a future secret can never ship in an
# export by accident.
_PROFILE = (
    UserTable.id, UserTable.username, UserTable.email, UserTable.display_name,
    UserTable.full_name, UserTable.department, UserTable.role_title,
    UserTable.avatar_url, UserTable.created_at, UserTable.last_login_at,
)
_PREFERENCES = (
    UserPreferencesTable.suggestions_enabled, UserPreferencesTable.show_message_token_usage,
    UserPreferencesTable.search_past_convs, UserPreferencesTable.use_memory,
    UserPreferencesTable.improve_model, UserPreferencesTable.personality,
    UserPreferencesTable.custom_instructions, UserPreferencesTable.voice_mode_voice,
    UserPreferencesTable.voice_mode_language, UserPreferencesTable.updated_at,
)
_TOOL_PREFS = (
    UserAgentToolPrefTable.id, UserAgentToolPrefTable.agent_slug, UserAgentToolPrefTable.tool_key,
    UserAgentToolPrefTable.state, UserAgentToolPrefTable.requires_approval,
    UserAgentToolPrefTable.updated_at,
)
_CONVERSATIONS = (
    ConversationTable.id, ConversationTable.agent_id, ConversationTable.agent_name,
    ConversationTable.title, ConversationTable.is_private, ConversationTable.is_archived,
    ConversationTable.archived_at, ConversationTable.forked_parent_id,
    ConversationTable.forked_message_id, ConversationTable.active_assistant_message_id,
    ConversationTable.created_at, ConversationTable.updated_at, ConversationTable.last_message_at,
)
_MESSAGES = (
    MessageTable.id, MessageTable.conversation_id, MessageTable.parent_message_id,
    MessageTable.sender, MessageTable.content, MessageTable.agent_name, MessageTable.liked,
    MessageTable.reasoning_steps, MessageTable.reasoning_time_seconds,
    MessageTable.input_tokens, MessageTable.output_tokens, MessageTable.cached_input_tokens,
    MessageTable.reasoning_tokens, MessageTable.model_latency_ms, MessageTable.context_tokens,
    MessageTable.context_window, MessageTable.model_name, MessageTable.model_calls,
    MessageTable.tool_calls, MessageTable.compaction, MessageTable.is_error,
    MessageTable.error_message, MessageTable.scheduled_task_id, MessageTable.created_at,
)
# Where each answer's tokens went (plan 33): main agent vs each sub-agent, by model.
_MESSAGE_USAGE = (
    MessageUsageTable.id, MessageUsageTable.message_id, MessageUsageTable.conversation_id,
    MessageUsageTable.main_agent_name, MessageUsageTable.scope, MessageUsageTable.agent_name,
    MessageUsageTable.model_name, MessageUsageTable.calls, MessageUsageTable.input_tokens,
    MessageUsageTable.cached_input_tokens, MessageUsageTable.output_tokens,
    MessageUsageTable.reasoning_tokens, MessageUsageTable.model_latency_ms,
    MessageUsageTable.created_at,
)
_ATTACHMENTS = (
    AttachmentTable.id, AttachmentTable.message_id, MessageTable.conversation_id,
    AttachmentTable.file_name, AttachmentTable.mime_type, AttachmentTable.size_bytes,
    AttachmentTable.origin, AttachmentTable.title, AttachmentTable.summary,
    AttachmentTable.created_at, AttachmentTable.blob_id,
)
_REPORTS = (
    ConversationReportTable.id, ConversationReportTable.conversation_id,
    ConversationReportTable.message_id, ConversationReportTable.reason,
    ConversationReportTable.details, ConversationReportTable.status,
    ConversationReportTable.created_at,
)
# Shares are listed so the user knows what they shared — never the link token
# (anyone holding the file could open the conversation) nor the snapshot copy.
_SHARES = (
    ConversationShareTable.id, ConversationShareTable.conversation_id,
    ConversationShareTable.title, ConversationShareTable.is_active,
    ConversationShareTable.revoked_at, ConversationShareTable.expires_at,
    ConversationShareTable.created_at,
)
_TASKS = (
    ScheduledTaskTable.id, ScheduledTaskTable.agent_name, ScheduledTaskTable.agent_slug,
    ScheduledTaskTable.conversation_id, ScheduledTaskTable.title, ScheduledTaskTable.prompt,
    ScheduledTaskTable.is_private, ScheduledTaskTable.target_mode,
    ScheduledTaskTable.schedule_kind, ScheduledTaskTable.schedule_spec,
    ScheduledTaskTable.timezone, ScheduledTaskTable.status, ScheduledTaskTable.next_run_at,
    ScheduledTaskTable.last_run_at, ScheduledTaskTable.last_run_status,
    ScheduledTaskTable.run_count, ScheduledTaskTable.max_runs, ScheduledTaskTable.expires_at,
    ScheduledTaskTable.created_at,
)


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        # Every timestamp column is naive UTC; say so in the value itself.
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"not JSON serialisable: {type(value).__name__}")


def _json_line(row: dict[str, Any]) -> bytes:
    return (json.dumps(row, ensure_ascii=False, separators=(",", ":"), default=_json_default) + "\n").encode("utf-8")


def attachment_archive_path(attachment_id: str, file_name: Optional[str]) -> str:
    """Where an attachment's bytes sit in the archive. One folder per attachment
    keeps two files with the same name apart."""
    return f"attachments/{attachment_id}/{safe_file_name(file_name)}"


# ---------------------------------------------------------------------------
# The one-time download token
# ---------------------------------------------------------------------------
def _secret() -> bytes:
    return settings.session.token_secret.get_secret_value().encode()


def mint_export_token(user_id: str, include_attachments: bool, *, now: Optional[float] = None) -> str:
    """A short-lived token naming the user and the export kind.

    Purpose-tagged ("export") so it can never be confused with another token
    signed by the same key, and carrying a random nonce so two tokens minted in
    the same second differ.
    """
    expiry = int(now if now is not None else time.time()) + settings.export.token_ttl_seconds
    payload = f"{_TOKEN_PURPOSE}:{user_id}:{int(include_attachments)}:{expiry}:{secrets.token_urlsafe(9)}"
    signature = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}:{signature}".encode()).decode().rstrip("=")


def verify_export_token(token: str, user_id: str, *, now: Optional[float] = None) -> Optional[bool]:
    """The ``include_attachments`` flag a valid token carries, else ``None``.

    Invalid means: malformed, wrong purpose, bad signature, expired, or minted
    for a different user. Each is the same ``None`` — the reason is not an oracle.
    """
    try:
        raw = base64.urlsafe_b64decode((token + "=" * (-len(token) % 4)).encode()).decode()
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    parts = raw.split(":")
    if len(parts) != 6:
        return None
    purpose, token_user, flag, expiry, nonce, signature = parts
    payload = f"{purpose}:{token_user}:{flag}:{expiry}:{nonce}"
    expected = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    if purpose != _TOKEN_PURPOSE or not hmac.compare_digest(token_user, user_id) or flag not in ("0", "1"):
        return None
    if not expiry.isdigit() or int(expiry) < (now if now is not None else time.time()):
        return None
    return flag == "1"


# ---------------------------------------------------------------------------
# Cooldown (durable) and concurrency (process-local)
# ---------------------------------------------------------------------------
def _utcnow() -> datetime:
    """Naive UTC, matching the ``timestamp without time zone`` columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _available_at(last_export_at: Optional[datetime]) -> Optional[datetime]:
    if last_export_at is None:
        return None
    ready = last_export_at + timedelta(minutes=settings.export.cooldown_minutes)
    return ready if ready > _utcnow() else None


@dataclass(frozen=True)
class ExportClaim:
    """The cooldown slot a running export took, and what to put back on failure."""

    user_id: str
    claimed_at: datetime
    previous: Optional[datetime]


async def claim_export(user_id: str) -> Optional[ExportClaim]:
    """Take the user's cooldown slot atomically, or ``None`` if it is not free.

    Optimistic: the UPDATE only lands if ``last_export_at`` still holds the value
    just read, so two downloads racing for the same slot cannot both win — and
    neither needs a lock held across the check.
    """
    now = _utcnow()
    async with SessionLocal() as session:
        previous = (await session.execute(
            select(UserTable.last_export_at).where(UserTable.id == user_id)
        )).scalar_one_or_none()
        if _available_at(previous) is not None:
            return None
        unchanged = UserTable.last_export_at.is_(None) if previous is None else UserTable.last_export_at == previous
        result = await session.execute(
            update(UserTable)
            .where(UserTable.id == user_id, unchanged)
            # Keep updated_at: starting an export is not a profile change.
            .values(last_export_at=now, updated_at=UserTable.updated_at)
        )
        await session.commit()
    return ExportClaim(user_id, now, previous) if result.rowcount == 1 else None


async def release_claim(claim: ExportClaim) -> None:
    """Give the cooldown slot back after an export that did not finish."""
    async with SessionLocal() as session:
        await session.execute(
            update(UserTable)
            .where(UserTable.id == claim.user_id, UserTable.last_export_at == claim.claimed_at)
            .values(last_export_at=claim.previous, updated_at=UserTable.updated_at)
        )
        await session.commit()


class _ExportSlots:
    """At most ``EXPORT_MAX_CONCURRENT`` exports at once, one per user.

    Leases rather than a semaphore, renewed while data flows (:meth:`touch`): a
    lease whose stream never started — the client left before the first byte,
    so no ``finally`` ran — or stopped moving expires a stall timeout later,
    instead of leaking a slot for as long as an export may legitimately run.
    Process-local, which matches the bridge's single worker and replica.
    """

    def __init__(self) -> None:
        self._leases: dict[str, float] = {}

    def try_acquire(self, user_id: str) -> bool:
        now = time.monotonic()
        horizon = settings.export.stall_seconds + 60
        self._leases = {uid: t for uid, t in self._leases.items() if now - t < horizon}
        if user_id in self._leases or len(self._leases) >= settings.export.max_concurrent:
            return False
        self._leases[user_id] = now
        return True

    def touch(self, user_id: str) -> None:
        """Renew a running export's lease — it is still moving."""
        if user_id in self._leases:
            self._leases[user_id] = time.monotonic()

    def release(self, user_id: str) -> None:
        self._leases.pop(user_id, None)


SLOTS = _ExportSlots()


async def export_status(user_id: str) -> dict[str, Any]:
    """Whether exports are on, and when this user may start the next one."""
    async with SessionLocal() as session:
        last = (await session.execute(
            select(UserTable.last_export_at).where(UserTable.id == user_id)
        )).scalar_one_or_none()
    ready = _available_at(last)
    return {
        "enabled": settings.export.enabled,
        "availableAt": _json_default(ready) if ready else None,
        "cooldownMinutes": settings.export.cooldown_minutes,
    }


def _retry_after_seconds(ready: Optional[datetime]) -> int:
    if ready is None:
        return 60
    return max(1, int((ready - _utcnow()).total_seconds()) + 1)


def _require_enabled() -> None:
    if not settings.export.enabled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Data export is turned off right now.")


async def issue_export_token(user_id: str, include_attachments: bool) -> dict[str, Any]:
    """Mint a download token — after checking the user could start an export now,
    so the browser is only sent to the download when it will succeed."""
    _require_enabled()
    async with SessionLocal() as session:
        last = (await session.execute(
            select(UserTable.last_export_at).where(UserTable.id == user_id)
        )).scalar_one_or_none()
    ready = _available_at(last)
    if ready is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="You exported your data recently. Please try again later.",
            headers={"Retry-After": str(_retry_after_seconds(ready))},
        )
    logger.info("export_token_issued", "Issued a data export download token",
                user_id=user_id, include_attachments=include_attachments)
    return {
        "token": mint_export_token(user_id, include_attachments),
        "expiresInSeconds": settings.export.token_ttl_seconds,
    }


async def start_export_download(user_id: str, token: str) -> StreamingResponse:
    """Check the token, take the cooldown and a slot, and start the stream."""
    _require_enabled()
    include_attachments = verify_export_token(token, user_id)
    if include_attachments is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="This download link is invalid or has expired.")
    claim = await claim_export(user_id)
    if claim is None:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="You exported your data recently. Please try again later.",
                            headers={"Retry-After": "60"})
    if not SLOTS.try_acquire(user_id):
        await release_claim(claim)
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Exports are busy right now. Please try again in a few minutes.",
                            headers={"Retry-After": "120"})
    filename = f"magenticx-export-{_utcnow():%Y-%m-%d}{'' if include_attachments else '-text-only'}.zip"
    logger.info("export_started", "Data export started", user_id=user_id,
                include_attachments=include_attachments)
    return StallGuardedStreamingResponse(
        stream_export(user_id, include_attachments=include_attachments, claim=claim),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            # Turn off response buffering in every nginx in front of us (ours,
            # and the shared NPM on Dennis), so the archive is never spooled to
            # a temp file on the way out.
            "X-Accel-Buffering": "no",
        },
    )


class StallGuardedStreamingResponse(StreamingResponse):
    """A streamed download that ends itself when the client stops reading.

    uvicorn applies backpressure: when the client stops reading, ``send`` simply
    waits — forever, if the client never resumes and never disconnects. Nothing
    inside the generator can notice, because it is suspended at its ``yield``.
    So every write here is bounded by ``EXPORT_STALL_SECONDS``; past it, the
    download is abandoned and the generator closed, which runs its ``finally``:
    the slot is freed and the cooldown handed back. The client is left with an
    incomplete archive, which cannot pass for a whole one (its directory is
    written last).
    """

    async def stream_response(self, send) -> None:
        stall = settings.export.stall_seconds
        await send({"type": "http.response.start", "status": self.status_code, "headers": self.raw_headers})
        try:
            async for chunk in self.body_iterator:
                try:
                    await asyncio.wait_for(
                        send({"type": "http.response.body", "body": chunk, "more_body": True}), timeout=stall
                    )
                except asyncio.TimeoutError:
                    logger.warning("export_stalled", "The client stopped reading; the export was ended",
                                   stall_seconds=stall)
                    # Returning without completing the response makes the server
                    # close the connection — the only way to end it under ASGI.
                    return
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        finally:
            aclose = getattr(self.body_iterator, "aclose", None)
            if aclose is not None:
                await aclose()


async def _pace(bytes_out: int, started: float) -> None:
    """Hold one export to ``EXPORT_MAX_BYTES_PER_SECOND`` on average.

    Waits only when the export is ahead of the cap — a slow client is already
    slower, and backpressure has throttled it.
    """
    owed = bytes_out / settings.export.max_bytes_per_second - (time.monotonic() - started)
    if owed > 0:
        await asyncio.sleep(owed)


# ---------------------------------------------------------------------------
# Paging
# ---------------------------------------------------------------------------
async def _pages(build: Callable[[Optional[tuple]], Select], key: Callable[[dict], tuple]) -> AsyncIterator[dict]:
    """Every row of a keyset-paged query, one short session per page.

    ``build(after)`` returns the query for the page after ``after`` (``None`` for
    the first page); ``key(row)`` is the keyset of a row. No session, connection
    or transaction outlives its page.
    """
    after: Optional[tuple] = None
    size = settings.export.page_rows
    while True:
        async with SessionLocal() as session:
            rows = [dict(row._mapping) for row in (await session.execute(build(after).limit(size))).all()]
        for row in rows:
            yield row
        if len(rows) < size:
            return
        after = key(rows[-1])


def _by_id(base: Select, column) -> Callable[[Optional[tuple]], Select]:
    def build(after: Optional[tuple]) -> Select:
        query = base.order_by(column)
        return query if after is None else query.where(column > after[0])
    return build


def _conversation_rows(user_id: str) -> AsyncIterator[dict]:
    return _pages(_by_id(select(*_CONVERSATIONS).where(ConversationTable.user_id == user_id),
                         ConversationTable.id), lambda r: (r["id"],))


async def _conversation_ids(user_id: str) -> AsyncIterator[str]:
    async for row in _pages(_by_id(select(ConversationTable.id).where(ConversationTable.user_id == user_id),
                                   ConversationTable.id), lambda r: (r["id"],)):
        yield row["id"]


def _message_rows(conversation_id: str) -> AsyncIterator[dict]:
    # Ordered range scan on ix_messages_conversation_id_id: no sort. Keyed on id,
    # not created_at — a timestamp can come back at a different precision than it
    # is bound at (SQLite drops the fraction), which would skip rows at a page
    # boundary. Readers wanting chronology sort by created_at.
    return _pages(_by_id(select(*_MESSAGES).where(MessageTable.conversation_id == conversation_id),
                         MessageTable.id), lambda r: (r["id"],))


def _attachment_rows(conversation_id: str) -> AsyncIterator[dict]:
    base = (select(*_ATTACHMENTS)
            .join(MessageTable, MessageTable.id == AttachmentTable.message_id)
            .where(MessageTable.conversation_id == conversation_id))
    return _pages(_by_id(base, AttachmentTable.id), lambda r: (r["id"],))


async def _all_messages(user_id: str) -> AsyncIterator[dict]:
    async for conversation_id in _conversation_ids(user_id):
        async for row in _message_rows(conversation_id):
            yield row


async def _all_message_usage(user_id: str) -> AsyncIterator[dict]:
    # Per conversation, like messages: each page is a small range on
    # ix_message_usage_conversation_id rather than a sort over every row the
    # user owns.
    async for conversation_id in _conversation_ids(user_id):
        base = select(*_MESSAGE_USAGE).where(MessageUsageTable.conversation_id == conversation_id)
        async for row in _pages(_by_id(base, MessageUsageTable.id), lambda r: (r["id"],)):
            yield row


async def _all_attachments(user_id: str, include_files: bool) -> AsyncIterator[dict]:
    async for conversation_id in _conversation_ids(user_id):
        async for row in _attachment_rows(conversation_id):
            blob_id = row.pop("blob_id")
            row["archive_path"] = (attachment_archive_path(row["id"], row["file_name"])
                                   if include_files and blob_id else None)
            yield row


async def _blob_slices(blob_id: str) -> AsyncIterator[bytes]:
    """An attachment's bytes, ``EXPORT_CHUNK_BYTES`` at a time."""
    size = settings.export.chunk_bytes
    position = 1
    while True:
        async with SessionLocal() as session:
            chunk = (await session.execute(
                select(func.substring(BlobTable.data, position, size)).where(BlobTable.id == blob_id)
            )).scalar_one_or_none()
        if not chunk:
            return
        data = chunk.tobytes() if isinstance(chunk, memoryview) else bytes(chunk)
        yield data
        if len(data) < size:
            return
        position += len(data)


# ---------------------------------------------------------------------------
# The archive
# ---------------------------------------------------------------------------
_README = """# Your mAgenticX data

This archive holds everything mAgenticX stores about your account, as of the
moment it was created. All times are UTC.

| Path | What it is |
| --- | --- |
| `account/profile.json` | Your profile |
| `account/preferences.json` | Your settings |
| `account/tool_preferences.ndjson` | Per-agent tool switches and approvals |
| `conversations/conversations.ndjson` | One conversation per line |
| `conversations/messages.ndjson` | One message per line, with its `conversation_id` |
| `conversations/message_usage.ndjson` | Where each answer's tokens went: the main agent and each sub-agent, by model |
| `conversations/attachments.ndjson` | One attachment per line; `archive_path` is where its file is in this archive (empty in a text-only export) |
| `conversations/reports.ndjson` | Conversations you reported |
| `conversations/shares.ndjson` | Conversations you shared (the links themselves are not included) |
| `scheduled_tasks.ndjson` | Your scheduled tasks |
| `attachments/<id>/<name>` | Your attachment files |
| `agents/` | Your custom agents: `agents.ndjson` plus each agent's files |
| `skills/` | Your skills: `skills.ndjson`, custom skills' files, and `assignments.ndjson` |
| `manifest.json` | What this archive contains, written last |

`.ndjson` files hold one JSON object per line. Skills you added from the
catalogue are listed with their source, version and licence rather than copied.
Agent memories are not included.
"""


class _Emitter:
    """Tracks the wall clock and what has been written, for the manifest."""

    def __init__(self) -> None:
        self.deadline = time.monotonic() + settings.export.max_seconds
        self.records: dict[str, int] = {}
        self.missing: list[str] = []
        self.bytes_out = 0

    def check(self) -> None:
        if time.monotonic() > self.deadline:
            raise ExportAborted("export ran past its time limit")


async def _ndjson(zs: ZipStream, em: _Emitter, path: str, rows: AsyncIterator[dict]) -> AsyncIterator[bytes]:
    yield await zs.open(path, compress=True)
    buffer = bytearray()
    count = 0
    async for row in rows:
        buffer += _json_line(row)
        count += 1
        if len(buffer) >= _FLUSH_BYTES:
            em.check()
            yield await zs.write(bytes(buffer))
            buffer.clear()
    if buffer:
        yield await zs.write(bytes(buffer))
    yield await zs.close()
    em.records[path] = count


async def _json_file(zs: ZipStream, path: str, document: Any) -> AsyncIterator[bytes]:
    yield await zs.open(path, compress=True)
    yield await zs.write(json.dumps(document, ensure_ascii=False, indent=2, default=_json_default).encode("utf-8"))
    yield await zs.close()


async def _single_row(columns: tuple, where) -> Optional[dict]:
    async with SessionLocal() as session:
        row = (await session.execute(select(*columns).where(where))).first()
    return dict(row._mapping) if row else None


async def _attachment_files(zs: ZipStream, em: _Emitter, user_id: str) -> AsyncIterator[bytes]:
    files = 0
    async for conversation_id in _conversation_ids(user_id):
        async for row in _attachment_rows(conversation_id):
            if not row.get("blob_id"):
                continue
            yield await zs.open(attachment_archive_path(row["id"], row["file_name"]), compress=False)
            async for chunk in _blob_slices(row["blob_id"]):
                em.check()
                yield await zs.write(chunk)
            yield await zs.close()
            files += 1
    em.records["attachments/"] = files


async def _agents_and_skills(zs: ZipStream, em: _Emitter, user_id: str) -> AsyncIterator[bytes]:
    """Copy the agents service's framed stream into the archive, frame by frame.

    If the service cannot be reached before anything was written, the export
    continues without this part and the manifest says so. Once a frame has been
    written the archive cannot be rolled back, so a failure after that point
    aborts the whole export rather than leave a half-written entry.
    """
    url = f"{_AGENTS_BASE_URL}/users/{user_id}/export"
    started = False
    open_encoding: Optional[str] = None
    try:
        async with httpx.AsyncClient(
            timeout=settings.http.agents_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
        ) as client:
            async with client.stream(
                "GET", url, headers=internal_service_headers(get_context().get("request_id"))
            ) as response:
                if response.status_code != 200:
                    raise ExportAborted(f"agents service answered {response.status_code}")
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        frame = json.loads(line)
                    except ValueError as exc:
                        raise ExportAborted("malformed frame from the agents service") from exc
                    op = frame.get("op")
                    if op == "open":
                        path = str(frame.get("path") or "")
                        check_archive_path(path)
                        if not path.startswith(_UPSTREAM_PREFIXES):
                            raise ExportAborted("agents service wrote outside agents/ and skills/")
                        open_encoding = "base64" if frame.get("encoding") == "base64" else "utf-8"
                        started = True
                        yield await zs.open(path, compress=open_encoding == "utf-8")
                    elif op == "data":
                        text = str(frame.get("text") or "")
                        data = (base64.b64decode(text, validate=True) if open_encoding == "base64"
                                else text.encode("utf-8"))
                        em.check()
                        yield await zs.write(data)
                    elif op == "close":
                        yield await zs.close()
                        open_encoding = None
                    elif op == "end":
                        for name, value in (frame.get("counts") or {}).items():
                            em.records[f"agents-service/{name}"] = int(value)
                        return
                    else:
                        raise ExportAborted(f"unknown frame {op!r} from the agents service")
                raise ExportAborted("the agents service stream ended early")
    except (httpx.HTTPError, ExportAborted, ValueError, binascii.Error) as exc:
        if started:
            raise ExportAborted("agents and skills could not be completed") from exc
        em.missing.append("agents and skills (the agents service was unavailable)")
        logger.warning("export_agents_part_missing", "Exported without agents and skills",
                       user_id=user_id, error_type=type(exc).__name__)


async def stream_export(user_id: str, *, include_attachments: bool, claim: ExportClaim) -> AsyncIterator[bytes]:
    """The archive, as it is built. See the module docstring for the guarantees."""
    zs = ZipStream()
    em = _Emitter()
    completed = False
    started_at = _utcnow()
    try:
        async def readme() -> AsyncIterator[bytes]:
            yield await zs.open("README.md", compress=True)
            yield await zs.write(_README.encode("utf-8"))
            yield await zs.close()

        async def account() -> AsyncIterator[bytes]:
            async for out in _json_file(zs, "account/profile.json",
                                        await _single_row(_PROFILE, UserTable.id == user_id) or {}):
                yield out
            async for out in _json_file(zs, "account/preferences.json",
                                        await _single_row(_PREFERENCES, UserPreferencesTable.user_id == user_id) or {}):
                yield out

        parts: list[AsyncIterator[bytes]] = [
            readme(),
            account(),
            _ndjson(zs, em, "account/tool_preferences.ndjson",
                    _pages(_by_id(select(*_TOOL_PREFS).where(UserAgentToolPrefTable.user_id == user_id),
                                  UserAgentToolPrefTable.id), lambda r: (r["id"],))),
            _ndjson(zs, em, "conversations/conversations.ndjson", _conversation_rows(user_id)),
            _ndjson(zs, em, "conversations/messages.ndjson", _all_messages(user_id)),
            _ndjson(zs, em, "conversations/message_usage.ndjson", _all_message_usage(user_id)),
            _ndjson(zs, em, "conversations/attachments.ndjson", _all_attachments(user_id, include_attachments)),
            _ndjson(zs, em, "conversations/reports.ndjson",
                    _pages(_by_id(select(*_REPORTS).where(ConversationReportTable.user_id == user_id),
                                  ConversationReportTable.id), lambda r: (r["id"],))),
            _ndjson(zs, em, "conversations/shares.ndjson",
                    _pages(_by_id(select(*_SHARES).where(ConversationShareTable.owner_user_id == user_id),
                                  ConversationShareTable.id), lambda r: (r["id"],))),
            _ndjson(zs, em, "scheduled_tasks.ndjson",
                    _pages(_by_id(select(*_TASKS).where(ScheduledTaskTable.user_id == user_id),
                                  ScheduledTaskTable.id), lambda r: (r["id"],))),
        ]
        if include_attachments:
            parts.append(_attachment_files(zs, em, user_id))
        parts.append(_agents_and_skills(zs, em, user_id))

        paced_from = time.monotonic()
        for part in parts:
            async for chunk in part:
                if chunk:
                    em.bytes_out += len(chunk)
                    yield chunk
                    SLOTS.touch(user_id)
                    await _pace(em.bytes_out, paced_from)

        manifest = {
            "format_version": FORMAT_VERSION,
            "generated_at": started_at,
            "user_id": user_id,
            "include_attachments": include_attachments,
            "records": em.records,
            "files": dict(zs.sizes),
            "missing": em.missing,
            "complete": not em.missing,
        }
        async for chunk in _json_file(zs, "manifest.json", manifest):
            em.bytes_out += len(chunk)
            yield chunk
        tail = await zs.finish()
        em.bytes_out += len(tail)
        yield tail
        completed = True
    finally:
        SLOTS.release(user_id)
        # Shielded: when the client goes away the stream is cancelled, and a
        # cancelled scope would cancel this write too — leaving the user locked
        # out for the whole cooldown by a download that never finished.
        with anyio.CancelScope(shield=True):
            if not completed:
                await release_claim(claim)
        logger.info(
            "export_finished" if completed else "export_aborted",
            "Data export finished" if completed else "Data export did not finish",
            user_id=user_id,
            include_attachments=include_attachments,
            bytes_sent=em.bytes_out,
            entries=len(zs.sizes),
            missing=em.missing or None,
        )


__all__ = [
    "ExportAborted",
    "ExportClaim",
    "SLOTS",
    "attachment_archive_path",
    "claim_export",
    "export_status",
    "issue_export_token",
    "mint_export_token",
    "release_claim",
    "start_export_download",
    "stream_export",
    "verify_export_token",
]
