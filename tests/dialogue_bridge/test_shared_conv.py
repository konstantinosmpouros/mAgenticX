"""Unit + DB tests for utils.shared_conv.

Pure helpers (``resolve_share_expires_at``, ``share_status``, ``share_mode``,
``build_share_list_item``) run against lightweight share stand-ins. The
DB-backed helpers (``load_active_share``, ``create_conversation_from_share_record``)
run against the real SQLite session: active-share filtering and full-share
continuation including message-tree re-parenting and attachment import.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select

from core.database import (
    AttachmentTable,
    ConversationShareTable,
    ConversationTable,
    MessageTable,
    b64_encode,
)
from core.settings import settings
from schemas import MessageIn
from utils.shared_conv import (
    build_share_list_item,
    create_conversation_from_share_record,
    load_active_share,
    parse_snapshot_datetime,
    resolve_share_expires_at,
    share_mode,
    share_status,
)


def _naive_utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def make_share(**overrides):
    base = dict(
        id="share-1",
        token="tok-1",
        conversation_id="conv-1",
        snapshot_until_message_id="msg-9",
        title="My share",
        snapshot_json={"shareMode": "branch"},
        is_active=True,
        revoked_at=None,
        expires_at=None,
        created_at=_naive_utcnow(),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


# ---------------------------------------------------------------------------
# parse_snapshot_datetime
# ---------------------------------------------------------------------------

def test_parse_snapshot_datetime_handles_z_suffix():
    parsed = parse_snapshot_datetime("2026-01-02T03:04:05Z")
    assert parsed == datetime(2026, 1, 2, 3, 4, 5)
    assert parsed.tzinfo is None


def test_parse_snapshot_datetime_none_and_invalid():
    assert parse_snapshot_datetime(None) is None
    assert parse_snapshot_datetime("") is None
    assert parse_snapshot_datetime("not-a-date") is None


# ---------------------------------------------------------------------------
# resolve_share_expires_at
# ---------------------------------------------------------------------------

def test_resolve_expires_defaults_to_30_days():
    now = datetime(2026, 1, 1)
    resolved = resolve_share_expires_at(None, now=now)
    assert resolved == now + timedelta(days=settings.share.default_ttl_days)


def test_resolve_expires_passthrough_within_bounds():
    now = datetime(2026, 1, 1)
    target = now + timedelta(days=10)
    assert resolve_share_expires_at(target, now=now) == target


def test_resolve_expires_strips_tzinfo():
    now = datetime(2026, 1, 1)
    aware = (now + timedelta(days=5)).replace(tzinfo=timezone.utc)
    resolved = resolve_share_expires_at(aware, now=now)
    assert resolved.tzinfo is None


def test_resolve_expires_beyond_max_raises_422():
    now = datetime(2026, 1, 1)
    too_far = now + timedelta(days=settings.share.max_ttl_days + 1)
    with pytest.raises(HTTPException) as exc:
        resolve_share_expires_at(too_far, now=now)
    assert exc.value.status_code == 422


# ---------------------------------------------------------------------------
# share_status
# ---------------------------------------------------------------------------

def test_share_status_active():
    now = datetime(2026, 1, 1)
    share = make_share(expires_at=now + timedelta(days=1))
    assert share_status(share, now=now) == "active"


def test_share_status_active_when_no_expiry():
    assert share_status(make_share(expires_at=None)) == "active"


def test_share_status_revoked_via_flag():
    assert share_status(make_share(is_active=False)) == "revoked"


def test_share_status_revoked_via_timestamp():
    assert share_status(make_share(revoked_at=_naive_utcnow())) == "revoked"


def test_share_status_expired():
    now = datetime(2026, 1, 2)
    share = make_share(expires_at=now - timedelta(days=1))
    assert share_status(share, now=now) == "expired"


# ---------------------------------------------------------------------------
# share_mode
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("mode", ["full", "branch", "message"])
def test_share_mode_valid_modes(mode):
    assert share_mode(make_share(snapshot_json={"shareMode": mode})) == mode


def test_share_mode_defaults_to_branch_on_unknown():
    assert share_mode(make_share(snapshot_json={"shareMode": "weird"})) == "branch"


def test_share_mode_defaults_to_branch_when_snapshot_not_dict():
    assert share_mode(make_share(snapshot_json=None)) == "branch"


# ---------------------------------------------------------------------------
# build_share_list_item
# ---------------------------------------------------------------------------

def test_build_share_list_item_maps_fields():
    now = datetime(2026, 1, 1)
    expires = now + timedelta(days=2)
    share = make_share(snapshot_json={"shareMode": "full"}, expires_at=expires)
    item = build_share_list_item(share, now=now)
    assert item.id == "share-1"
    assert item.token == "tok-1"
    assert item.shareUrl == "/share/tok-1"
    assert item.conversationId == "conv-1"
    assert item.messageId == "msg-9"
    assert item.shareMode == "full"
    assert item.isActive is True
    assert item.status == "active"
    assert item.expiresAt == expires


def test_build_share_list_item_status_revoked():
    share = make_share(is_active=False, revoked_at=_naive_utcnow())
    item = build_share_list_item(share)
    assert item.status == "revoked"
    assert item.isActive is False


# ---------------------------------------------------------------------------
# load_active_share (DB)
# ---------------------------------------------------------------------------

async def _add_share(session, seeded_user, conversation_id, **overrides):
    base = dict(
        token="share-token",
        conversation_id=conversation_id,
        owner_user_id=seeded_user.id,
        snapshot_until_message_id=None,
        title="Shared",
        snapshot_json={"shareMode": "branch"},
        is_active=True,
        revoked_at=None,
        expires_at=None,
    )
    base.update(overrides)
    share = ConversationShareTable(**base)
    session.add(share)
    await session.commit()
    await session.refresh(share)
    return share


async def test_load_active_share_returns_active(session_factory, seeded_user, conversation_factory):
    created = await conversation_factory(title="C")
    async with session_factory() as session:
        await _add_share(session, seeded_user, created["conversation_id"], token="live")
    async with session_factory() as session:
        share = await load_active_share("live", session)
        assert share.token == "live"


async def test_load_active_share_unknown_token_raises_404(session_factory):
    async with session_factory() as session:
        with pytest.raises(HTTPException) as exc:
            await load_active_share("does-not-exist", session)
    assert exc.value.status_code == 404


async def test_load_active_share_revoked_raises_404(session_factory, seeded_user, conversation_factory):
    created = await conversation_factory(title="C")
    async with session_factory() as session:
        await _add_share(
            session, seeded_user, created["conversation_id"], token="revoked", is_active=False, revoked_at=_naive_utcnow()
        )
    async with session_factory() as session:
        with pytest.raises(HTTPException) as exc:
            await load_active_share("revoked", session)
    assert exc.value.status_code == 404


async def test_load_active_share_expired_raises_404(session_factory, seeded_user, conversation_factory):
    created = await conversation_factory(title="C")
    async with session_factory() as session:
        await _add_share(
            session,
            seeded_user,
            created["conversation_id"],
            token="expired",
            expires_at=_naive_utcnow() - timedelta(days=1),
        )
    async with session_factory() as session:
        with pytest.raises(HTTPException) as exc:
            await load_active_share("expired", session)
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# create_conversation_from_share_record (DB)
# ---------------------------------------------------------------------------

def _first_message() -> MessageIn:
    return MessageIn(sender="user", type="text", content="Let's continue this chat")


async def test_create_from_share_rejects_non_full_mode(session_factory, seeded_user, seeded_agent):
    share = SimpleNamespace(
        snapshot_json={"shareMode": "branch"},
        title="t",
    )
    async with session_factory() as session:
        with pytest.raises(HTTPException) as exc:
            await create_conversation_from_share_record(
                db=session, share=share, current_user=seeded_user, first_message=_first_message()
            )
    assert exc.value.status_code == 400
    assert "full-conversation" in exc.value.detail


async def test_create_from_share_rejects_empty_messages(session_factory, seeded_user):
    share = SimpleNamespace(snapshot_json={"shareMode": "full", "messages": []}, title="t")
    async with session_factory() as session:
        with pytest.raises(HTTPException) as exc:
            await create_conversation_from_share_record(
                db=session, share=share, current_user=seeded_user, first_message=_first_message()
            )
    assert exc.value.status_code == 400
    assert "no messages" in exc.value.detail


async def test_create_from_share_rejects_unavailable_agent(session_factory, seeded_user):
    share = SimpleNamespace(
        snapshot_json={
            "shareMode": "full",
            "messages": [{"id": "1", "sender": "user", "content": "hi"}],
            "agent": {"id": "ghost-agent"},
        },
        title="t",
    )
    async with session_factory() as session:
        with pytest.raises(HTTPException) as exc:
            await create_conversation_from_share_record(
                db=session, share=share, current_user=seeded_user, first_message=_first_message()
            )
    assert exc.value.status_code == 400
    assert "agent is unavailable" in exc.value.detail


async def test_create_from_share_imports_full_conversation(session_factory, seeded_user, seeded_agent):
    image_bytes = b"\x89PNG image-data"
    share = SimpleNamespace(
        snapshot_json={
            "shareMode": "full",
            "title": "Imported chat",
            "agent": {"id": seeded_agent.id},
            "messages": [
                {
                    "id": "src-1",
                    "sender": "user",
                    "type": "text",
                    "content": "first user message",
                    "created_at": "2026-01-01T00:00:00Z",
                    "attachments": [
                        {
                            "name": "shot.png",
                            "mime": "image/png",
                            "data": b64_encode(image_bytes),
                            "size": len(image_bytes),
                            "timestamp": "2026-01-01T00:00:00Z",
                        }
                    ],
                },
                {
                    "id": "src-2",
                    "parentMessageId": "src-1",
                    "sender": "ai",
                    "type": "text",
                    "content": "assistant reply",
                    "liked": True,
                },
            ],
        },
        title="fallback title",
    )

    async with session_factory() as session:
        conv_full, first_reply_id = await create_conversation_from_share_record(
            db=session, share=share, current_user=seeded_user, first_message=_first_message()
        )
        assert conv_full.title == "Imported chat"
        assert conv_full.user_id == seeded_user.id
        assert conv_full.agent_id == seeded_agent.id
        conv_id = conv_full.id
        # The util only flushes; the caller owns the commit boundary.
        await session.commit()

    async with session_factory() as session:
        messages = (
            (
                await session.execute(
                    select(MessageTable)
                    .where(MessageTable.conversation_id == conv_id)
                    .order_by(MessageTable.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        # Two imported + one new user message = 3 rows.
        assert len(messages) == 3
        by_content = {m.content: m for m in messages}
        imported_user = by_content["first user message"]
        imported_ai = by_content["assistant reply"]
        # Re-parenting maps the snapshot id chain onto the new DB ids.
        assert imported_ai.parent_message_id == imported_user.id
        assert imported_ai.liked is True
        # The newly added first message hangs off the last imported message.
        new_user = by_content["Let's continue this chat"]
        assert new_user.id == first_reply_id
        assert new_user.parent_message_id == imported_ai.id

        attachments = (
            (await session.execute(select(AttachmentTable).where(AttachmentTable.message_id == imported_user.id)))
            .scalars()
            .all()
        )
        assert len(attachments) == 1
        assert attachments[0].file_name == "shot.png"
        assert attachments[0].mime_type == "image/png"
