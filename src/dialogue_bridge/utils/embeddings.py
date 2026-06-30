"""Per-conversation message embeddings (pgvector) — generation + retrieval.

The bridge has no OpenAI key, so embeddings are produced by the agents service
(``POST /embed``, the same proxy pattern as realtime voice) and stored locally
in ``message_embeddings``. A background **sweeper** fills embeddings in off the
request path: each pass claims a batch of messages that have no embedding yet
(finalized, non-error, non-empty content, conversation not private), embeds them
in one call, and upserts. Because it works off "rows without an embedding", the
same loop handles both freshly-created messages and the historical backfill, and
is self-healing — a failed embed is simply retried on the next pass.

Retrieval embeds the query the same way and runs a cosine KNN over the vectors,
then rolls the nearest messages up to their conversations (best match wins),
strictly scoped to the requesting user and excluding private conversations.
"""
from __future__ import annotations

import asyncio

import httpx
from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import SessionLocal
from core.security.internal_trust import internal_service_headers
from core.security.tls import get_httpx_client_cert, get_httpx_verify
from core.settings import settings
from observability import get_context, get_logger
from schemas import MemoryMessageMatch

logger = get_logger(__name__)


# Messages eligible for embedding: finalized (user messages have NULL streaming
# status; AI messages only once 'completed'), not an error, non-empty content,
# and belonging to a non-private conversation. Newest first so recent chats
# become searchable fastest while the historical backlog drains behind them.
_CLAIM_SQL = text(
    """
    SELECT m.id AS id, m.content AS content
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN message_embeddings e ON e.message_id = m.id
    WHERE e.message_id IS NULL
      AND m.content IS NOT NULL
      AND length(btrim(m.content)) > 0
      AND m.is_error = false
      AND c.is_private = false
      AND (m.streaming_status IS NULL OR m.streaming_status = 'completed')
    ORDER BY m.created_at DESC
    LIMIT :limit
    """
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


async def _embed_pending_batch(db: AsyncSession) -> int:
    """Embed one batch of pending messages. Returns how many were stored."""
    rows = (await db.execute(_CLAIM_SQL, {"limit": settings.embeddings.sweeper_batch_size})).all()
    if not rows:
        return 0

    texts = [_slice_for_embedding(content) for _, content in rows]
    vectors, model = await embed_texts(texts)

    params = [
        {"message_id": message_id, "embedding": _vector_literal(vector), "model": model}
        for (message_id, _content), vector in zip(rows, vectors)
    ]
    await db.execute(_STORE_SQL, params)
    await db.commit()
    return len(params)


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
        embedded = 0
        try:
            async with SessionLocal() as db:
                embedded = await _embed_pending_batch(db)
            if embedded:
                logger.info("embedding_sweeper_pass", "Embedded message batch", embedded_count=embedded)
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "embedding_sweeper_embed_failed",
                "Embedding pass failed against the agents service; will retry",
                failure_reason=type(exc).__name__,
            )
        except Exception:  # noqa: BLE001 — a daemon loop must survive any DB/runtime hiccup
            logger.error(
                "embedding_sweeper_unexpected_error",
                "Unexpected error in embedding sweeper; will retry",
                exc_info=True,
            )

        delay = (
            settings.embeddings.sweeper_active_seconds
            if embedded
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
