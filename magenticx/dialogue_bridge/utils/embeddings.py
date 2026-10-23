"""Per-conversation message embeddings (pgvector) — generation + retrieval.

The bridge has no OpenAI key, so embeddings are produced by the agents service
(``POST /embed``, the same proxy pattern as realtime voice) and stored locally
in ``message_embeddings``. A background **sweeper** fills embeddings in off the
request path: each pass reads a batch of messages it has not looked at yet
(``messages.embedding_checked_at IS NULL``, served by a partial index), embeds
the ones that qualify (finalized, non-error, non-empty content, conversation not
private) in one call, and marks the whole batch checked in the same transaction.
The same loop handles freshly-created messages and the historical backfill, and
is self-healing — a failed embed commits nothing, so the batch is retried.

Retrieval embeds the query the same way and runs a cosine KNN over the vectors,
then rolls the nearest messages up to their conversations (best match wins),
strictly scoped to the requesting user and excluding private conversations.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException, status
from sqlalchemy import or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import ConversationTable, MessageTable, SessionLocal
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from core.logging import get_context, get_logger
from schema import MemoryMessageMatch
from utils.inference_runs import ACTIVE_RUN_STATUSES

logger = get_logger(__name__)


def _utcnow() -> datetime:
    """Naive UTC, matching the ``timestamp without time zone`` columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _pending_batch_query(limit: int):
    """The next messages the sweeper has not looked at, newest first.

    Served by ``ix_messages_embedding_pending`` (only unchecked rows), so a pass
    reads one batch whatever the table's size — and nothing at all when there is
    no backlog. A run still in flight is left for a later pass: its content is
    not final yet.
    """
    return (
        select(
            MessageTable.id,
            MessageTable.content,
            MessageTable.is_error,
            MessageTable.streaming_status,
            ConversationTable.is_private,
        )
        .join(ConversationTable, ConversationTable.id == MessageTable.conversation_id)
        .where(
            MessageTable.embedding_checked_at.is_(None),
            or_(
                MessageTable.streaming_status.is_(None),
                MessageTable.streaming_status.not_in(ACTIVE_RUN_STATUSES),
            ),
        )
        .order_by(MessageTable.created_at.desc())
        .limit(limit)
    )


def _embeddable(row) -> bool:
    """Whether a looked-at message gets a vector: finalized (user messages have
    no streaming status; AI messages only once 'completed'), not an error, with
    content, in a conversation that is not private. "Not embeddable" is final —
    the message is marked checked and never looked at again — except when a
    private conversation is saved ("Save chat"): that clears the marks on its
    messages (``save_private_conversation``), so they come back through here."""
    return (
        bool(row.content and row.content.strip())
        and not row.is_error
        and not row.is_private
        and row.streaming_status in (None, "completed")
    )


# ON CONFLICT DO NOTHING makes the upsert idempotent (and safe if two sweepers
# ever race over the same message under multi-replica).
_STORE_SQL = text(
    """
    INSERT INTO message_embeddings (message_id, embedding, model, created_at)
    VALUES (:message_id, CAST(:embedding AS vector), :model, now())
    ON CONFLICT (message_id) DO NOTHING
    """
)

# Message-level cosine KNN (the agent memory tool wants individual past
# messages, not a per-conversation roll-up). User-scoped, private excluded, and
# the current conversation optionally excluded so it surfaces *other* chats.
_MESSAGE_SEARCH_SQL = text(
    """
    SELECT m.id AS message_id,
           m.conversation_id AS conversation_id,
           m.sender AS sender,
           m.content AS content,
           m.created_at AS created_at,
           m.updated_at AS updated_at,
           c.title AS title,
           c.last_message_preview AS last_message_preview,
           (e.embedding <=> CAST(:qvec AS vector)) AS distance
    FROM message_embeddings e
    JOIN messages m ON m.id = e.message_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = :user_id
      AND c.is_private = false
      -- CAST(... AS text): asyncpg can't infer the type of a NULL bind used in
      -- IS NULL / <>, so type it explicitly (AmbiguousParameterError otherwise).
      AND (
        CAST(:exclude_conversation_id AS text) IS NULL
        OR m.conversation_id <> CAST(:exclude_conversation_id AS text)
      )
    ORDER BY e.embedding <=> CAST(:qvec AS vector)
    LIMIT :limit
    """
)


def _vector_literal(vec: list[float]) -> str:
    """Render a float list as a pgvector text literal: ``[0.1,0.2,...]``.

    We bind vectors as strings + ``CAST(... AS vector)`` rather than via an
    asyncpg type codec — it needs no per-connection registration and we never
    read the raw vector back into Python, so this is the simplest robust path.
    """
    return "[" + ",".join(str(float(x)) for x in vec) + "]"


def _slice_for_embedding(content: str | None) -> str:
    return (content or "")[: settings.embeddings.max_chars_per_message]


def _conversation_title(row) -> str:
    title = (row["title"] or "").strip()
    if title:
        return title
    preview = (row["last_message_preview"] or "").strip()
    return preview or "Untitled chat"


async def embed_texts(texts: list[str]) -> tuple[list[list[float]], str]:
    """Embed a batch of texts via the agents service. Returns (vectors, model).

    Raises ``httpx`` errors or ``ValueError`` on failure; callers decide whether
    to retry (sweeper) or surface a clean error (search endpoint).
    """
    if not texts:
        return [], settings.embeddings.embed_path  # model unused for empty batch
    request_id = get_context().get("request_id")
    headers = internal_service_headers(request_id)
    url = f"{settings.upstream.agents_service_url.rstrip('/')}{settings.embeddings.embed_path}"
    async with httpx.AsyncClient(
        timeout=settings.http.embeddings_timeout,
        verify=get_httpx_verify(),
        cert=get_httpx_client_cert(),
    ) as client:
        response = await client.post(url, json={"texts": texts}, headers=headers)
        response.raise_for_status()

    data = response.json()
    embeddings = data.get("embeddings") if isinstance(data, dict) else None
    if not isinstance(embeddings, list) or len(embeddings) != len(texts):
        got = len(embeddings) if isinstance(embeddings, list) else "non-list"
        raise ValueError(f"agents /embed returned {got} vectors for {len(texts)} texts")
    model = data.get("model") if isinstance(data.get("model"), str) else "unknown"
    return embeddings, model


async def _embed_pending_batch(db: AsyncSession) -> tuple[int, int]:
    """Look at one batch of queued messages; embed those that qualify.

    Returns ``(looked_at, embedded)``. The vectors and the "checked" marks commit
    together, so a failed embed leaves the whole batch queued for the next pass.
    """
    rows = (await db.execute(_pending_batch_query(settings.embeddings.sweeper_batch_size))).all()
    if not rows:
        return 0, 0

    targets = [row for row in rows if _embeddable(row)]
    if targets:
        vectors, model = await embed_texts([_slice_for_embedding(row.content) for row in targets])
        await db.execute(
            _STORE_SQL,
            [
                {"message_id": row.id, "embedding": _vector_literal(vector), "model": model}
                for row, vector in zip(targets, vectors)
            ],
        )
    # Bookkeeping, not an edit: keep updated_at as it was.
    await db.execute(
        update(MessageTable)
        .where(MessageTable.id.in_([row.id for row in rows]))
        .values(embedding_checked_at=_utcnow(), updated_at=MessageTable.updated_at)
    )
    await db.commit()
    return len(rows), len(targets)


async def run_embedding_sweeper(stop_event: asyncio.Event) -> None:
    """Background loop: keep embedding messages that don't have an embedding yet.

    Sleeps briefly after a productive pass and longer when idle; exits promptly
    when ``stop_event`` is set. Errors are logged and retried — the loop never
    dies on a transient agents/DB failure.
    """
    if not settings.embeddings.enabled:
        logger.info("embedding_sweeper_disabled", "Embedding sweeper disabled via settings")
        return

    logger.info("embedding_sweeper_started", "Embedding sweeper started")
    while not stop_event.is_set():
        looked_at = 0
        try:
            async with SessionLocal() as db:
                looked_at, embedded = await _embed_pending_batch(db)
            if looked_at:
                logger.info("embedding_sweeper_pass", "Embedded message batch",
                            embedded_count=embedded, checked_count=looked_at)
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "embedding_sweeper_embed_failed",
                "Embedding pass failed against the agents service; will retry",
                failure_reason=type(exc).__name__,
            )
        except Exception:
            logger.error(
                "embedding_sweeper_unexpected_error",
                "Unexpected error in embedding sweeper; will retry",
                exc_info=True,
            )

        # Keep going while there is a queue — a batch of non-embeddable rows
        # is still progress — and back off only when it is empty.
        delay = (
            settings.embeddings.sweeper_active_seconds
            if looked_at
            else settings.embeddings.sweeper_idle_seconds
        )
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    logger.info("embedding_sweeper_stopped", "Embedding sweeper stopped")


async def search_user_messages(
    db: AsyncSession,
    *,
    user_id: str,
    query: str,
    limit: int,
    exclude_conversation_id: str | None = None,
) -> list[MemoryMessageMatch]:
    """Return the user's individual past messages most relevant to ``query``.

    Backs the agents service's `search_past_conversations` tool: message-level
    (not rolled up to conversations) so the agent can pull specific old turns to
    refer to. User-scoped, private excluded, current conversation optionally
    excluded. Raises ``HTTPException(503)`` if the query can't be embedded.
    """
    cleaned = query.strip()
    if not cleaned:
        return []

    limit = max(1, min(limit, settings.embeddings.tool_max_limit))
    try:
        vectors, _model = await embed_texts([_slice_for_embedding(cleaned)])
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(
            "memory_search_embed_failed",
            "Query embedding failed against the agents service",
            failure_reason=type(exc).__name__,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Memory search is temporarily unavailable. Please try again.",
        ) from exc

    if not vectors:
        return []

    rows = (
        await db.execute(
            _MESSAGE_SEARCH_SQL,
            {
                "user_id": user_id,
                "qvec": _vector_literal(vectors[0]),
                "limit": limit,
                "exclude_conversation_id": exclude_conversation_id,
            },
        )
    ).mappings().all()

    max_chars = settings.embeddings.tool_message_max_chars
    return [
        MemoryMessageMatch(
            messageId=row["message_id"],
            conversationId=row["conversation_id"],
            conversationTitle=_conversation_title(row),
            sender=row["sender"],
            content=(row["content"] or "").strip()[:max_chars],
            score=round(1.0 - float(row["distance"]), 4),
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )
        for row in rows
    ]
