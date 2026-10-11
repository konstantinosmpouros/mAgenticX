"""Store every file an agent wrote this run, as generated attachments on its answer.

A deep agent writes files to the conversation's ``output/`` dir on the agents
volume, which a TTL sweep empties after a week. Postgres is the record of a
conversation's files, so every run — completed, failed or cancelled; what was
written exists either way — has its files stored, in two steps:

1. **In the finalize transaction, the presented files only**
   (:func:`capture_presented_files`). Their cards are on screen and match an
   attachment on this answer, so they must exist when the run's terminal frame
   reaches the UI. Usually zero or one small file.
2. **After the commit, everything else** (:func:`schedule_remaining_capture`),
   in a background task, so the UI's terminal frame never waits for it. It
   reads the ``output/`` manifest (path, size, SHA-256 — never bytes), keeps
   the files the conversation does not hold yet — a new ``(file name, SHA-256)``
   pair, so an edited file becomes a new version — and fetches those in batches
   bounded by count and bytes, so a run that wrote many large files never holds
   them all in memory. Captures of one conversation run one after another, so
   two runs can never both store the same file.

Every stored row is ``AttachmentTable(origin="generated")`` + ``BlobTable`` on
the answer, with ``content_sha256`` taken from the bytes received and
``presented`` set for the files the agent showed. Fail-open throughout: the
answer is already persisted, so an unreachable agents service, a file gone
mid-capture or bad base64 is logged and skipped — never a failed run. A capture
lost to a restart heals on the next run: the files are still on the volume, and
the manifest shows them as not held yet.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
from typing import Any

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable, SessionLocal
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from utils.agents import build_agent_output_files_url, build_agent_output_manifest_url, get_agent_by_id

logger = get_logger(__name__)


async def _agents_get(url: str, params: list[tuple[str, str]] | None = None) -> dict[str, Any]:
    """One authenticated internal GET to the agents service (mTLS + trusted-proxy header)."""
    async with httpx.AsyncClient(
        timeout=settings.http.inference_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    ) as client:
        resp = await client.get(url, params=params, headers=internal_service_headers(get_context().get("request_id")))
        resp.raise_for_status()
        data = resp.json()
    return data if isinstance(data, dict) else {}


async def fetch_output_manifest(url: str) -> list[dict[str, Any]]:
    """Every file in ``output/``: ``{path, filename, mime, size, sha256}``."""
    files = (await _agents_get(url)).get("files")
    return [f for f in files if isinstance(f, dict)] if isinstance(files, list) else []


async def fetch_output_files(url: str, paths: list[str]) -> list[dict[str, Any]]:
    """The named files, base64. Paths the agent could not return are simply absent."""
    files = (await _agents_get(url, [("paths", p) for p in paths])).get("files")
    return [f for f in files if isinstance(f, dict)] if isinstance(files, list) else []


async def _stored_versions(db: AsyncSession, conversation_id: str) -> set[tuple[str, str]]:
    """``(file name, SHA-256)`` of every generated file this conversation already holds."""
    rows = await db.execute(
        select(AttachmentTable.file_name, AttachmentTable.content_sha256)
        .join(MessageTable, AttachmentTable.message_id == MessageTable.id)
        .where(
            MessageTable.conversation_id == conversation_id,
            AttachmentTable.origin == "generated",
            AttachmentTable.content_sha256.is_not(None),
        )
    )
    return {(name, digest) for name, digest in rows.all()}


def select_files_to_capture(
    manifest: list[dict[str, Any]], stored: set[tuple[str, str]]
) -> tuple[list[dict[str, Any]], int]:
    """The manifest entries the conversation does not hold yet, within the per-run
    caps, and how many were left out."""
    cfg = settings.output_capture
    wanted = [entry for entry in manifest if (entry.get("filename"), entry.get("sha256")) not in stored]
    chosen: list[dict[str, Any]] = []
    total = 0
    for entry in wanted:
        size = int(entry.get("size") or 0)
        if len(chosen) >= cfg.max_files_per_run or total + size > cfg.max_bytes_per_run:
            continue
        chosen.append(entry)
        total += size
    return chosen, len(wanted) - len(chosen)


def _batches(entries: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split into fetches of at most ``batch_files`` files and ``batch_bytes`` bytes
    (a single file larger than a batch still goes alone)."""
    cfg = settings.output_capture
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    size = 0
    for entry in entries:
        entry_size = int(entry.get("size") or 0)
        if current and (len(current) >= cfg.batch_files or size + entry_size > cfg.batch_bytes):
            batches.append(current)
            current, size = [], 0
        current.append(entry)
        size += entry_size
    if current:
        batches.append(current)
    return batches


async def _deep_agent(run: MessageTable, conversation: ConversationTable) -> Any | None:
    """The run's agent when it is a deep agent (only those have a filesystem), else ``None``."""
    agent = await get_agent_by_id(run.agent_id or conversation.agent_id)
    return agent if getattr(agent, "type", "") == "deep agent" else None


async def _store_fetched(
    db: AsyncSession,
    run: MessageTable,
    url: str,
    paths: list[str],
    meta_by_path: dict[str, dict[str, Any]],
) -> tuple[int, int]:
    """Fetch ``paths`` and add one generated attachment per file. Returns (stored, skipped)."""
    try:
        fetched = await fetch_output_files(url, paths)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(
            "output_capture_batch_failed",
            "Could not fetch a batch of output files; the rest is still captured",
            run_id=run.id,
            files=len(paths),
            error_type=type(exc).__name__,
        )
        return 0, len(paths)
    stored = 0
    skipped = len(paths) - len(fetched)  # absent or over the agents' size cap
    for f in fetched:
        try:
            raw = base64.b64decode(f.get("base64", ""), validate=True)
        except (ValueError, TypeError):
            skipped += 1
            continue
        meta = meta_by_path.get(f.get("path"), {})
        db.add(
            AttachmentTable(
                message_id=run.id,
                file_name=f.get("filename") or str(f.get("path", "")).rsplit("/", 1)[-1] or "file",
                mime_type=f.get("mime") or "application/octet-stream",
                size_bytes=len(raw),
                origin="generated",
                title=meta.get("title") or None,
                summary=meta.get("summary") or None,
                presented=bool(meta),
                # From the bytes actually stored, not the manifest's claim.
                content_sha256=hashlib.sha256(raw).hexdigest(),
                blob=BlobTable(data=raw),
            )
        )
        stored += 1
    return stored, skipped


async def capture_presented_files(
    db: AsyncSession,
    run: MessageTable,
    conversation: ConversationTable | None,
    presented: list[dict[str, Any]],
) -> None:
    """Step 1, in the finalize transaction: the files the agent presented this run.

    Always stored on this answer, even when unchanged — the card matches an
    attachment on its own message. The rows commit with the caller's finalize.
    """
    meta_by_path = {a["path"]: a for a in presented if a.get("path")}
    if conversation is None or not meta_by_path:
        return
    try:
        agent = await _deep_agent(run, conversation)
    except HTTPException as exc:  # the agent is gone
        logger.error("output_capture_agent_missing", "Could not resolve the run's agent",
                     run_id=run.id, error_type=type(exc).__name__)
        return
    if agent is None:
        return
    url = build_agent_output_files_url(agent, str(conversation.user_id), str(run.conversation_id))
    paths, size = list(meta_by_path), settings.output_capture.batch_files
    stored = skipped = 0
    for start in range(0, len(paths), size):
        done, missed = await _store_fetched(db, run, url, paths[start:start + size], meta_by_path)
        stored, skipped = stored + done, skipped + missed
    logger.info("presented_files_captured", "Stored the files the agent presented",
                run_id=run.id, captured=stored, skipped=skipped)


async def _capture_remaining(run_id: str, presented: list[dict[str, Any]]) -> None:
    """Step 2, in the background: every other new or changed file in ``output/``."""
    meta_by_path = {a["path"]: a for a in presented if a.get("path")}
    async with SessionLocal() as db:
        run = await db.get(MessageTable, run_id)
        conversation = await db.get(ConversationTable, run.conversation_id) if run else None
        if run is None or conversation is None:
            return
        user_id, conversation_id = str(conversation.user_id), str(run.conversation_id)
        try:
            agent = await _deep_agent(run, conversation)
            if agent is None:
                return
            manifest = await fetch_output_manifest(build_agent_output_manifest_url(agent, user_id, conversation_id))
        except (httpx.HTTPError, ValueError, HTTPException) as exc:  # HTTPException: agent gone
            logger.error("output_capture_manifest_failed", "Could not list the run's output files",
                         run_id=run_id, error_type=type(exc).__name__)
            return
        if not manifest:
            return
        # The presented files were stored in step 1, so the hash check skips them.
        chosen, left_out = select_files_to_capture(manifest, await _stored_versions(db, conversation_id))
        url = build_agent_output_files_url(agent, user_id, conversation_id)
        captured = skipped = 0
        for batch in _batches(chosen):
            done, missed = await _store_fetched(db, run, url, [str(e["path"]) for e in batch], meta_by_path)
            captured, skipped = captured + done, skipped + missed
        await db.commit()
    if captured or skipped or left_out:
        logger.info("output_files_captured", "Stored the run's output files as generated attachments",
                    run_id=run_id, captured=captured, skipped=skipped, over_run_cap=left_out)


# The latest capture task per conversation. A new one waits for the previous,
# so two runs of one conversation never both decide a file is "not held yet".
# In-process is enough: the bridge runs as one replica, and a capture lost to a
# restart heals on the next run.
_chains: dict[str, asyncio.Task[None]] = {}


async def _chained(previous: asyncio.Task[None] | None, run_id: str, presented: list[dict[str, Any]]) -> None:
    if previous is not None:
        await asyncio.gather(previous, return_exceptions=True)
    try:
        await _capture_remaining(run_id, presented)
    except Exception:  # noqa: BLE001 — a background task must log its failure, never die silently
        logger.error("output_capture_crashed", "The background file capture failed", exc_info=True, run_id=run_id)


def schedule_remaining_capture(conversation_id: str, run_id: str, presented: list[dict[str, Any]]) -> None:
    """Step 2: queue the background capture of the run's other files (see the module docstring)."""
    task = asyncio.create_task(_chained(_chains.get(conversation_id), run_id, list(presented)))
    _chains[conversation_id] = task

    def _forget(done: asyncio.Task[None]) -> None:
        if _chains.get(conversation_id) is done:
            del _chains[conversation_id]

    task.add_done_callback(_forget)


async def wait_for_pending_captures() -> None:
    """Wait for every queued background capture (tests, and a graceful shutdown)."""
    while _chains:
        await asyncio.gather(*list(_chains.values()), return_exceptions=True)
