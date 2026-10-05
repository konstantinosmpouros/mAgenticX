"""One-shot: delete the attachment blobs orphaned before migration 0030.

Until ``trg_attachments_delete_blob`` existed, deleting a conversation removed
its attachments but never their blobs (the foreign key points attachment →
blob, so the cascade never reaches the bytes). Those blobs are unreachable —
nothing points at them, so neither the UI nor an account deletion can find
them — and they are the deleted conversations' files, which users expect gone.

This removes them once, in the background after boot: batched by bytes and
paced exactly like the account purge, because deleting a blob writes about its
own size to the WAL on a disk every stack on Dennis shares. Only blobs older
than an hour are touched, so a row written in the same moment as this runs can
never be mistaken for an orphan. Idempotent: an interrupted run resumes on the
next boot, and a finished one finds nothing.

**One-shot migration code** (the plan 25/26 pruner pattern): delete this module
and its start-up hook once it has run on Dennis — tracked in ``magenticx/TODO``.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, exists, func, select
from sqlalchemy.exc import SQLAlchemyError

import utils.account_deletion as account_deletion
from core.database import AttachmentTable, BlobTable, SessionLocal
from core.logging import get_logger
from core.settings import settings

logger = get_logger(__name__)

#: A blob younger than this is never treated as an orphan.
_MIN_AGE = timedelta(hours=1)


async def prune_orphaned_blobs() -> dict[str, int]:
    """Delete every blob no attachment points at. Returns what was removed."""
    cfg = settings.account_deletion
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - _MIN_AGE
    removed = {"blobs": 0, "bytes": 0}
    try:
        while True:
            started = time.monotonic()
            async with SessionLocal() as session:
                rows = (
                    await session.execute(
                        select(BlobTable.id, func.length(BlobTable.data))
                        .where(
                            ~exists().where(AttachmentTable.blob_id == BlobTable.id),
                            BlobTable.created_at < cutoff,
                        )
                        .limit(cfg.blob_batch)
                    )
                ).all()
                if not rows:
                    break
                blob_ids, batch_bytes = account_deletion.within_byte_budget(rows, cfg.blob_batch_bytes)
                await session.execute(delete(BlobTable).where(BlobTable.id.in_(blob_ids)))
                await session.commit()
            removed["blobs"] += len(blob_ids)
            removed["bytes"] += batch_bytes
            await account_deletion.pace_bytes(batch_bytes, started)
    except SQLAlchemyError as exc:
        # Idempotent: whatever is left is picked up on the next boot.
        logger.warning("orphaned_blobs_prune_failed", "Pruning orphaned blobs stopped; it resumes on the next boot",
                       error_type=type(exc).__name__, **removed)
        return removed
    if removed["blobs"]:
        logger.info("orphaned_blobs_pruned", "Deleted blobs no attachment pointed at", **removed)
    return removed
