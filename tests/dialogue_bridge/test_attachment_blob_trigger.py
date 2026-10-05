"""Deleting an attachment deletes its blob (migration 0030).

The foreign key runs attachments → blobs, so a cascade from a conversation,
message or user never reached the bytes: every deleted conversation left its
files behind, where not even an account deletion could find them. A trigger
on ``attachments`` now removes the blob whatever deleted the row.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, func, select

import utils.orphaned_blobs as orphaned_blobs
from core.database import AttachmentTable, BlobTable, ConversationTable, MessageTable


async def _attachment(session_factory, user, agent):
    async with session_factory() as s:
        conv = ConversationTable(user_id=user.id, agent_id=agent.id, title="t")
        s.add(conv)
        await s.flush()
        msg = MessageTable(conversation_id=conv.id, sender="user", content="x")
        s.add(msg)
        await s.flush()
        blob = BlobTable(data=b"bytes")
        keep = BlobTable(data=b"someone else's bytes")
        s.add_all([blob, keep])
        await s.flush()
        att = AttachmentTable(message_id=msg.id, file_name="f.txt", mime_type="text/plain", blob_id=blob.id)
        s.add(att)
        await s.commit()
        return att.id, blob.id, keep.id


async def _blobs(session_factory, *ids) -> int:
    async with session_factory() as s:
        return (await s.execute(select(func.count()).select_from(BlobTable).where(BlobTable.id.in_(ids)))).scalar_one()


@pytest.mark.asyncio
async def test_deleting_an_attachment_deletes_its_blob_and_only_its_blob(session_factory, seeded_user, seeded_agent):
    att_id, blob_id, keep_id = await _attachment(session_factory, seeded_user, seeded_agent)
    assert await _blobs(session_factory, blob_id) == 1

    async with session_factory() as s:
        await s.execute(delete(AttachmentTable).where(AttachmentTable.id == att_id))
        await s.commit()

    assert await _blobs(session_factory, blob_id) == 0
    assert await _blobs(session_factory, keep_id) == 1


@pytest.mark.asyncio
async def test_the_one_shot_prune_removes_old_orphans_only(session_factory, seeded_user, seeded_agent, monkeypatch):
    """Blobs left by conversations deleted before 0030 go; a referenced blob and
    a brand-new unreferenced one (it may be mid-write) stay."""
    monkeypatch.setattr(orphaned_blobs, "SessionLocal", session_factory)
    _, referenced, _ = await _attachment(session_factory, seeded_user, seeded_agent)
    old = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=90)
    async with session_factory() as s:
        orphan = BlobTable(data=b"x" * 100, created_at=old)
        fresh = BlobTable(data=b"y" * 100)
        s.add_all([orphan, fresh])
        await s.commit()
        orphan_id, fresh_id = orphan.id, fresh.id

    removed = await orphaned_blobs.prune_orphaned_blobs()

    assert await _blobs(session_factory, orphan_id) == 0
    assert await _blobs(session_factory, fresh_id) == 1
    assert await _blobs(session_factory, referenced) == 1
    assert removed["blobs"] >= 1 and removed["bytes"] >= 100
    assert (await orphaned_blobs.prune_orphaned_blobs())["blobs"] == 0   # idempotent
