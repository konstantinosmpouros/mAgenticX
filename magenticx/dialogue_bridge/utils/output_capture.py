"""Snapshot the files an agent presented this run, as attachments on its answer.

A deep agent's files are durable in the agents service (``agent_runtime``,
plan 43) for as long as the conversation exists, so only the files it
*presented* (``present_artifact``) are copied here — in the finalize
transaction, so each card finds its file when the run's terminal frame reaches
the UI. The copy is a deliberate snapshot: the card on an answer keeps the
version presented then, even if the agent later edits the file, and share
links, forks and the PDF export carry it like any other attachment.

Every stored row is ``AttachmentTable(origin="generated", presented=True)`` +
``BlobTable`` on the answer, with ``content_sha256`` taken from the bytes
received. Fail-open throughout: the answer is already persisted, so an
unreachable agents service, a file gone or bad base64 is logged and skipped —
never a failed run.
"""
from __future__ import annotations

import base64
import hashlib
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable
from core.logging import get_context, get_logger
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from utils.agents import build_conversation_files_url

logger = get_logger(__name__)


async def fetch_output_files(url: str, paths: list[str]) -> list[dict[str, Any]]:
    """The named files, base64. Paths the agent could not return are simply absent."""
    async with httpx.AsyncClient(
        timeout=settings.http.inference_timeout, verify=get_httpx_verify(), cert=get_httpx_client_cert()
    ) as client:
        resp = await client.get(
            url,
            params=[("paths", path) for path in paths],
            headers=internal_service_headers(get_context().get("request_id")),
        )
        resp.raise_for_status()
        files = resp.json().get("files")
    return [f for f in files if isinstance(f, dict)] if isinstance(files, list) else []


async def _store_fetched(
    db: AsyncSession, run: MessageTable, url: str, meta_by_path: dict[str, dict[str, Any]]
) -> tuple[int, int]:
    """Fetch the presented paths and add one generated attachment per file.
    Returns (stored, skipped)."""
    paths = list(meta_by_path)
    try:
        fetched = await fetch_output_files(url, paths)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("output_capture_batch_failed", "Could not fetch the presented files",
                       run_id=run.id, files=len(paths), error_type=type(exc).__name__)
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
                presented=True,
                # From the bytes actually stored, not anyone's claim.
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
    """In the finalize transaction: the files the agent presented this run.

    Always stored on this answer, even when unchanged — the card matches an
    attachment on its own message. The rows commit with the caller's finalize.
    Fetched in batches of ``OUTPUT_CAPTURE_BATCH_FILES`` (the agents service
    returns at most that many per request).
    """
    meta_by_path = {a["path"]: a for a in presented if a.get("path")}
    if conversation is None or not meta_by_path:
        return
    url = build_conversation_files_url(str(conversation.user_id), str(run.conversation_id))
    paths, size = list(meta_by_path), settings.output_capture.batch_files
    stored = skipped = 0
    for start in range(0, len(paths), size):
        batch = {path: meta_by_path[path] for path in paths[start:start + size]}
        done, missed = await _store_fetched(db, run, url, batch)
        stored, skipped = stored + done, skipped + missed
    logger.info("presented_files_captured", "Stored the files the agent presented",
                run_id=run.id, captured=stored, skipped=skipped)
