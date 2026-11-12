"""A conversation's sources as rows in ``agent_runtime`` (plan 42 §3.7).

Every sub-agent is a background task with its own run, and its events reach the
UI only while its drill-down is open — yet the orchestrator cites what its tasks
found. So the run's event log cannot be the registry a citation resolves
against: every source a tool returned is also kept here, per conversation, and
the UI loads them with the conversation.

``conversation_sources`` — ``(user_id, conversation_id, source_id)`` → the
source as encrypted JSON ``{url, title, snippet, tool}``. Search terms show
through a result's URLs and snippets, so the payload gets the same protection
as the conversation's files: the checkpointer's AES key and cipher
(:mod:`harness.conversation_files.cipher`). A write is an upsert — the same page
keeps its id, and its row is refreshed.

Lifecycle mirrors the conversation's files: copied on fork, deleted with the
conversation, purged with the account. The service is the table's only reader
and writer, so it owns the DDL and creates it on boot.
"""
from __future__ import annotations

import json
from typing import Any

from pydantic import ValidationError

from core.logging import get_logger
from harness.conversation_files.cipher import FileCipher, get_file_cipher
from harness.sources.model import Source

logger = get_logger(__name__)

#: Most sources one list returns — the newest first.
MAX_LISTED_SOURCES = 500

_DDL = (
    """
    CREATE TABLE IF NOT EXISTS conversation_sources (
        user_id         text NOT NULL,
        conversation_id text NOT NULL,
        source_id       text NOT NULL,
        cipher          text NOT NULL,
        payload         bytea NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, conversation_id, source_id),
        CONSTRAINT conversation_sources_id_ck CHECK (source_id ~ '^[0-9a-f]{6,8}$')
    )
    """,
    # Encrypted bytes do not compress; EXTERNAL skips the futile attempt.
    "ALTER TABLE conversation_sources ALTER COLUMN payload SET STORAGE EXTERNAL",
    # Serves the newest-first list of one conversation.
    "CREATE INDEX IF NOT EXISTS conversation_sources_recent_idx "
    "ON conversation_sources (user_id, conversation_id, updated_at DESC)",
)

_COMMENTS = (
    "COMMENT ON TABLE conversation_sources IS "
    "'Web pages a tool returned in a conversation, by source id (plan 42). Citations resolve against it.'",
    "COMMENT ON COLUMN conversation_sources.payload IS "
    "'JSON {url, title, snippet, tool}, encrypted with LANGGRAPH_AES_KEY unless cipher is none.'",
)

_SCOPE = "user_id = %(user_id)s AND conversation_id = %(conversation_id)s"

_UPSERT = (
    "INSERT INTO conversation_sources (user_id, conversation_id, source_id, cipher, payload) "
    "VALUES (%(user_id)s, %(conversation_id)s, %(source_id)s, %(cipher)s, %(payload)s) "
    "ON CONFLICT (user_id, conversation_id, source_id) DO UPDATE SET "
    "cipher = EXCLUDED.cipher, payload = EXCLUDED.payload, updated_at = now()"
)


class ConversationSourceStore:
    """Reads and writes one user's conversation sources.

    Every statement filters on both ``user_id`` and ``conversation_id``, so a
    wrong conversation id from a caller can never reach another user's rows.
    """

    def __init__(self, pool: Any, cipher: FileCipher | None = None) -> None:
        self._pool = pool
        self._cipher = cipher or get_file_cipher()

    async def setup(self) -> None:
        """Create the table if absent — ``agent_runtime`` has no alembic chain."""
        async with self._pool.connection() as conn:
            for statement in (*_DDL, *_COMMENTS):
                await conn.execute(statement)

    def _seal(self, source: Source) -> tuple[str, bytes]:
        payload = source.model_dump(exclude={"id"})
        return self._cipher.encrypt(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def _open(self, row: dict[str, Any]) -> Source:
        payload = json.loads(self._cipher.decrypt(row["cipher"], bytes(row["payload"])))
        return Source(id=row["source_id"], **payload)

    async def upsert_many(self, user_id: str, conversation_id: str, sources: list[Source]) -> int:
        """Keep ``sources`` for the conversation, refreshing any already kept."""
        unique = list({source.id: source for source in sources}.values())
        if not unique:
            return 0
        params = []
        for source in unique:
            cipher, payload = self._seal(source)
            params.append({"user_id": user_id, "conversation_id": conversation_id,
                           "source_id": source.id, "cipher": cipher, "payload": payload})
        async with self._pool.connection() as conn, conn.transaction(), conn.cursor() as cur:
            await cur.executemany(_UPSERT, params)
        return len(unique)

    async def list_sources(self, user_id: str, conversation_id: str,
                           limit: int = MAX_LISTED_SOURCES) -> list[Source]:
        """The conversation's sources, newest first, at most ``limit``.

        A row that no longer validates (the schema tightened since it was
        written) is skipped and counted, never served.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT source_id, cipher, payload FROM conversation_sources WHERE {_SCOPE} "
                "ORDER BY updated_at DESC, source_id LIMIT %(limit)s",
                {"user_id": user_id, "conversation_id": conversation_id,
                 "limit": max(0, min(limit, MAX_LISTED_SOURCES))},
            )
            rows = await cur.fetchall()
        sources: list[Source] = []
        skipped = 0
        for row in rows:
            try:
                sources.append(self._open(row))
            except (ValidationError, ValueError, TypeError):
                skipped += 1
        if skipped:
            logger.warning("conversation_sources_skipped", "Skipped stored sources that no longer validate",
                           skipped=skipped)
        return sources

    async def copy_conversation(self, user_id: str, source_conversation_id: str, target_conversation_id: str) -> int:
        """Give a fork every source of the conversation it was forked from.

        Ids the target already has are kept, so a retried copy changes nothing.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "INSERT INTO conversation_sources "
                "(user_id, conversation_id, source_id, cipher, payload, created_at, updated_at) "
                "SELECT user_id, %(target)s, source_id, cipher, payload, created_at, updated_at "
                "FROM conversation_sources WHERE user_id = %(user_id)s AND conversation_id = %(source)s "
                "ON CONFLICT (user_id, conversation_id, source_id) DO NOTHING",
                {"user_id": user_id, "source": source_conversation_id, "target": target_conversation_id},
            )
            copied = cur.rowcount or 0
        logger.info("conversation_sources_copied", "Copied a conversation's sources to its fork", sources=copied)
        return copied

    async def delete_conversation(self, user_id: str, conversation_id: str) -> int:
        """Delete every source of one conversation. Returns how many."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"DELETE FROM conversation_sources WHERE {_SCOPE}",
                {"user_id": user_id, "conversation_id": conversation_id},
            )
            removed = cur.rowcount or 0
        logger.info("conversation_sources_reaped", "Deleted a conversation's sources", sources=removed)
        return removed

    async def purge_user(self, user_id: str) -> dict[str, int]:
        """Account deletion: every source the user has, in every conversation."""
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute("DELETE FROM conversation_sources WHERE user_id = %s", (user_id,))
        counts = {"conversation_sources": cur.rowcount or 0}
        logger.info("conversation_sources_purged", "Deleted a user's conversation sources", **counts)
        return counts


__all__ = ["MAX_LISTED_SOURCES", "ConversationSourceStore"]
