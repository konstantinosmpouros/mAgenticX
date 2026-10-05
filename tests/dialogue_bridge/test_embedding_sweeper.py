"""The embedding sweeper's queue (migration 0031).

It used to find work by anti-joining every message against message_embeddings
on every pass — 4.4 GB of temp files with a 200k-message backlog, and a full
scan every few seconds even with none. It now reads one batch off a partial
index of messages it has not looked at, and marks every message it looks at,
embedded or not, so nothing is looked at twice.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, text

import utils.embeddings as embeddings
from core.database import ConversationTable, MessageEmbeddingTable, MessageTable
from core.settings import settings


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# The production insert is Postgres SQL (now(), CAST … AS vector); the same row
# in SQLite's dialect, so the bookkeeping around it runs for real here.
_SQLITE_STORE = text(
    "INSERT OR IGNORE INTO message_embeddings (message_id, embedding, model, created_at) "
    "VALUES (:message_id, :embedding, :model, CURRENT_TIMESTAMP)"
)


@pytest.fixture()
def embed_calls(monkeypatch):
    monkeypatch.setattr(embeddings, "_STORE_SQL", _SQLITE_STORE)
    calls: list[list[str]] = []

    async def fake_embed(texts):
        calls.append(list(texts))
        return [[0.0] * 1536 for _ in texts], "test-model"

    monkeypatch.setattr(embeddings, "embed_texts", fake_embed)
    return calls


async def _seed(session_factory, user, agent):
    # Booleans set explicitly: SQLite stores the "false" server defaults as text.
    async with session_factory() as s:
        public = ConversationTable(user_id=user.id, agent_id=agent.id, title="public", is_private=False)
        private = ConversationTable(user_id=user.id, agent_id=agent.id, title="private", is_private=True)
        s.add_all([public, private])
        await s.flush()
        base = _now() - timedelta(minutes=10)
        rows = {
            "ok": MessageTable(conversation_id=public.id, sender="user", content="embed me", created_at=base, is_error=False),
            "empty": MessageTable(conversation_id=public.id, sender="user", content="   ", created_at=base, is_error=False),
            "error": MessageTable(conversation_id=public.id, sender="ai", content="boom", is_error=True,
                                  streaming_status="failed", created_at=base),
            "private": MessageTable(conversation_id=private.id, sender="user", content="secret", created_at=base, is_error=False),
            "running": MessageTable(conversation_id=public.id, sender="ai", content="half",
                                    streaming_status="running", created_at=base, is_error=False),
            "done": MessageTable(conversation_id=public.id, sender="ai", content="final answer",
                                 streaming_status="completed", created_at=base, is_error=False),
        }
        s.add_all(rows.values())
        await s.commit()
        return {k: v.id for k, v in rows.items()}, {k: v.updated_at for k, v in rows.items()}


async def _checked(session_factory, message_id):
    async with session_factory() as s:
        return (await s.get(MessageTable, message_id)).embedding_checked_at


@pytest.mark.asyncio
async def test_a_pass_embeds_what_qualifies_and_marks_everything_it_looked_at(
    session_factory, seeded_user, seeded_agent, embed_calls
):
    ids, updated = await _seed(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        looked_at, embedded = await embeddings._embed_pending_batch(s)

    assert (looked_at, embedded) == (5, 2)                              # all but the in-flight run
    assert sorted(embed_calls[0]) == ["embed me", "final answer"]
    for key in ("ok", "empty", "error", "private", "done"):
        assert await _checked(session_factory, ids[key]) is not None, key
    assert await _checked(session_factory, ids["running"]) is None     # content not final yet
    async with session_factory() as s:
        vectors = (await s.execute(select(func.count()).select_from(MessageEmbeddingTable))).scalar_one()
        assert vectors == 2
        # Bookkeeping, not an edit: updated_at is untouched.
        assert (await s.get(MessageTable, ids["ok"])).updated_at == updated["ok"]


@pytest.mark.asyncio
async def test_nothing_is_looked_at_twice(session_factory, seeded_user, seeded_agent, embed_calls):
    await _seed(session_factory, seeded_user, seeded_agent)
    async with session_factory() as s:
        await embeddings._embed_pending_batch(s)
    async with session_factory() as s:
        assert await embeddings._embed_pending_batch(s) == (0, 0)
    assert len(embed_calls) == 1


@pytest.mark.asyncio
async def test_a_failed_embed_leaves_the_batch_queued(session_factory, seeded_user, seeded_agent, monkeypatch):
    ids, _ = await _seed(session_factory, seeded_user, seeded_agent)

    async def failing(_texts):
        raise ValueError("agents /embed returned 0 vectors for 2 texts")

    monkeypatch.setattr(embeddings, "embed_texts", failing)
    async with session_factory() as s:
        with pytest.raises(ValueError):
            await embeddings._embed_pending_batch(s)
    assert await _checked(session_factory, ids["ok"]) is None
    assert await _checked(session_factory, ids["empty"]) is None


@pytest.mark.asyncio
async def test_batches_are_newest_first_and_bounded(session_factory, seeded_user, seeded_agent, embed_calls, monkeypatch):
    monkeypatch.setattr(settings.embeddings, "sweeper_batch_size", 2)
    async with session_factory() as s:
        conv = ConversationTable(user_id=seeded_user.id, agent_id=seeded_agent.id, title="c", is_private=False)
        s.add(conv)
        await s.flush()
        base = _now() - timedelta(hours=1)
        s.add_all([MessageTable(conversation_id=conv.id, sender="user", content=f"m{i}", is_error=False,
                                created_at=base + timedelta(minutes=i)) for i in range(5)])
        await s.commit()
    async with session_factory() as s:
        assert await embeddings._embed_pending_batch(s) == (2, 2)
    assert sorted(embed_calls[0]) == ["m3", "m4"]
