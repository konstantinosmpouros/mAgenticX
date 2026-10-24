"""A conversation's files as rows in ``agent_runtime`` (plan 43).

Two tables, so that a byte is stored once however many paths name it:

* ``conversation_file_blobs`` — ``(user_id, sha256)`` → the bytes, encrypted
  with the checkpointer's key (:mod:`.cipher`). Content-addressed per user, so
  a fork, a copy or the same report written twice share one blob. Never
  across users: a shared blob would let one tenant learn that another holds a
  given file, and would tie one account's deletion to another's data.
* ``conversation_files`` — ``(conversation_id, path)`` → a blob. Small rows;
  listing, globbing and forking never touch a byte of content.

A blob lives while any row names it. The foreign key from rows to blobs is the
guard: a blob still referenced cannot be deleted, so garbage collection can be
optimistic — delete what *looks* unreferenced, and let the constraint refuse
the one a concurrent write just picked up (:meth:`_collect_garbage`).

The service is this table's only reader and writer, so — like memory, skills
and agent definitions — it owns the DDL and creates it on boot.
"""
from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

import psycopg

from core.logging import get_logger
from harness.conversation_files import paths
from harness.conversation_files.cipher import FileCipher, get_file_cipher

logger = get_logger(__name__)

#: What a write came to. Anything but ``ok`` changed nothing.
WriteOutcome = Literal["ok", "exists", "is_directory", "parent_is_file"]

_DDL = (
    """
    CREATE TABLE IF NOT EXISTS conversation_file_blobs (
        user_id     text NOT NULL,
        sha256      text NOT NULL,
        size_bytes  bigint NOT NULL,
        cipher      text NOT NULL,
        data        bytea NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, sha256)
    )
    """,
    # Encrypted bytes do not compress; EXTERNAL skips the futile attempt.
    "ALTER TABLE conversation_file_blobs ALTER COLUMN data SET STORAGE EXTERNAL",
    """
    CREATE TABLE IF NOT EXISTS conversation_files (
        conversation_id text NOT NULL,
        path            text COLLATE "C" NOT NULL,
        user_id         text NOT NULL,
        sha256          text NOT NULL,
        size_bytes      bigint NOT NULL,
        agent_slug      text NOT NULL,
        source_run_id   text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, path),
        CONSTRAINT conversation_files_blob_fk FOREIGN KEY (user_id, sha256)
            REFERENCES conversation_file_blobs (user_id, sha256),
        CONSTRAINT conversation_files_path_ck CHECK (
            path ~ '^/(conversation|large_tool_results|conversation_history)/.+'
            AND path !~ '^/conversation/input(/|$)'
        )
    )
    """,
    # Serves the account purge, the blob GC's "still referenced?" probe and
    # the foreign key's own check when a blob is deleted.
    "CREATE INDEX IF NOT EXISTS conversation_files_blob_idx ON conversation_files (user_id, sha256)",
)

_COMMENTS = (
    "COMMENT ON TABLE conversation_files IS "
    "'A conversation''s files by virtual path (plan 43). Bytes live in conversation_file_blobs.'",
    "COMMENT ON COLUMN conversation_files.agent_slug IS "
    "'The agent that last wrote the file. Provenance only; files belong to the conversation.'",
    "COMMENT ON COLUMN conversation_file_blobs.cipher IS "
    "'none, or the LangGraph cipher name (aes) that encrypted data with LANGGRAPH_AES_KEY.'",
)

_ENTRY_COLUMNS = "path, size_bytes, sha256, agent_slug, updated_at"
_SCOPE = "conversation_id = %(conversation_id)s AND user_id = %(user_id)s"

_GC_ATTEMPTS = 3


@dataclass(frozen=True)
class FileEntry:
    """A file without its bytes — what listing and globbing work from."""

    path: str
    size: int
    sha256: str
    agent_slug: str
    updated_at: datetime


def _entry(row: dict[str, Any]) -> FileEntry:
    return FileEntry(
        path=row["path"],
        size=int(row["size_bytes"]),
        sha256=row["sha256"],
        agent_slug=row["agent_slug"],
        updated_at=row["updated_at"],
    )


def _scope(user_id: str, conversation_id: str, **extra: Any) -> dict[str, Any]:
    return {"user_id": user_id, "conversation_id": conversation_id, **extra}


class ConversationFileStore:
    """Reads and writes one user's conversation files.

    Every statement filters on both ``conversation_id`` and ``user_id``, so a
    wrong conversation id from a caller can never reach another user's rows.
    Paths are expected already normalised (:func:`paths.normalise`).
    """

    def __init__(self, pool: Any, cipher: FileCipher | None = None) -> None:
        self._pool = pool
        self._cipher = cipher or get_file_cipher()

    async def setup(self) -> None:
        """Create the tables if absent — ``agent_runtime`` has no alembic chain."""
        async with self._pool.connection() as conn:
            for statement in (*_DDL, *_COMMENTS):
                await conn.execute(statement)

    # -- reads ---------------------------------------------------------------
    async def list_files(self, user_id: str, conversation_id: str, directory: str = "/") -> list[FileEntry]:
        """Every file at ``directory`` or below it, in path order, without bytes."""
        lower, upper = paths.children_range(directory)
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_ENTRY_COLUMNS} FROM conversation_files WHERE {_SCOPE} "
                "AND (path = %(path)s OR (path >= %(lower)s AND path < %(upper)s)) ORDER BY path",
                _scope(user_id, conversation_id, path=directory, lower=lower, upper=upper),
            )
            return [_entry(row) for row in await cur.fetchall()]

    async def stat(self, user_id: str, conversation_id: str, path: str) -> FileEntry | None:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_ENTRY_COLUMNS} FROM conversation_files WHERE {_SCOPE} AND path = %(path)s",
                _scope(user_id, conversation_id, path=path),
            )
            row = await cur.fetchone()
        return _entry(row) if row else None

    async def read(self, user_id: str, conversation_id: str, path: str) -> bytes | None:
        return (await self.read_many(user_id, conversation_id, [path])).get(path)

    async def read_many(self, user_id: str, conversation_id: str, file_paths: list[str]) -> dict[str, bytes]:
        """The plaintext of each named file that exists, keyed by path."""
        if not file_paths:
            return {}
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT f.path, b.cipher, b.data FROM conversation_files f "
                "JOIN conversation_file_blobs b ON b.user_id = f.user_id AND b.sha256 = f.sha256 "
                "WHERE f.conversation_id = %(conversation_id)s AND f.user_id = %(user_id)s "
                "AND f.path = ANY(%(paths)s)",
                _scope(user_id, conversation_id, paths=list(file_paths)),
            )
            rows = await cur.fetchall()
        return {row["path"]: self._cipher.decrypt(row["cipher"], bytes(row["data"])) for row in rows}

    # -- writes --------------------------------------------------------------
    async def create(
        self, user_id: str, conversation_id: str, path: str, data: bytes, *,
        agent_slug: str, run_id: str | None = None,
    ) -> WriteOutcome:
        """Write a new file; never replaces one (``exists`` instead)."""
        outcome: WriteOutcome = "exists"
        async with self._pool.connection() as conn, conn.transaction():
            conflict = await self._conflict(conn, user_id, conversation_id, path, allow_existing=False)
            if conflict is not None:
                return conflict
            sha256 = await self._save_blob(conn, user_id, data)
            cur = await conn.execute(
                "INSERT INTO conversation_files "
                "(conversation_id, path, user_id, sha256, size_bytes, agent_slug, source_run_id) "
                "VALUES (%(conversation_id)s, %(path)s, %(user_id)s, %(sha256)s, %(size)s, %(agent_slug)s, %(run_id)s) "
                "ON CONFLICT (conversation_id, path) DO NOTHING RETURNING path",
                _scope(user_id, conversation_id, path=path, sha256=sha256, size=len(data),
                       agent_slug=agent_slug, run_id=run_id),
            )
            if await cur.fetchone() is None:
                # A concurrent write took the path first; drop the blob we added.
                raise psycopg.Rollback()
            outcome = "ok"
        return outcome

    async def replace(
        self, user_id: str, conversation_id: str, path: str, data: bytes, *,
        agent_slug: str, run_id: str | None = None,
    ) -> WriteOutcome:
        """Write a file, replacing whatever was at ``path``."""
        async with self._pool.connection() as conn, conn.transaction():
            conflict = await self._conflict(conn, user_id, conversation_id, path, allow_existing=True)
            if conflict is not None:
                return conflict
            cur = await conn.execute(
                f"SELECT sha256 FROM conversation_files WHERE {_SCOPE} AND path = %(path)s FOR UPDATE",
                _scope(user_id, conversation_id, path=path),
            )
            previous = await cur.fetchone()
            sha256 = await self._save_blob(conn, user_id, data)
            await conn.execute(
                "INSERT INTO conversation_files "
                "(conversation_id, path, user_id, sha256, size_bytes, agent_slug, source_run_id) "
                "VALUES (%(conversation_id)s, %(path)s, %(user_id)s, %(sha256)s, %(size)s, %(agent_slug)s, %(run_id)s) "
                "ON CONFLICT (conversation_id, path) DO UPDATE SET sha256 = EXCLUDED.sha256, "
                "size_bytes = EXCLUDED.size_bytes, agent_slug = EXCLUDED.agent_slug, "
                "source_run_id = EXCLUDED.source_run_id, updated_at = now()",
                _scope(user_id, conversation_id, path=path, sha256=sha256, size=len(data),
                       agent_slug=agent_slug, run_id=run_id),
            )
            if previous is not None and previous["sha256"] != sha256:
                await self._collect_garbage(conn, user_id, [previous["sha256"]])
        return "ok"

    async def edit(
        self, user_id: str, conversation_id: str, path: str,
        transform: Callable[[bytes], bytes | None], *,
        agent_slug: str, run_id: str | None = None,
    ) -> bool:
        """Read-modify-write one file under a row lock. False when it does not exist.

        ``transform`` gets the current bytes and returns the new ones, or None
        to leave the file as it is. The lock makes two parallel edits (two
        sub-agents on one file) apply one after the other instead of the second
        silently undoing the first.
        """
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "SELECT f.sha256, b.cipher, b.data FROM conversation_files f "
                "JOIN conversation_file_blobs b ON b.user_id = f.user_id AND b.sha256 = f.sha256 "
                "WHERE f.conversation_id = %(conversation_id)s AND f.user_id = %(user_id)s "
                "AND f.path = %(path)s FOR UPDATE OF f",
                _scope(user_id, conversation_id, path=path),
            )
            row = await cur.fetchone()
            if row is None:
                return False
            updated = transform(self._cipher.decrypt(row["cipher"], bytes(row["data"])))
            if updated is None:
                return True
            sha256 = await self._save_blob(conn, user_id, updated)
            if sha256 == row["sha256"]:
                return True
            await conn.execute(
                f"UPDATE conversation_files SET sha256 = %(sha256)s, size_bytes = %(size)s, "
                f"agent_slug = %(agent_slug)s, source_run_id = %(run_id)s, updated_at = now() "
                f"WHERE {_SCOPE} AND path = %(path)s",
                _scope(user_id, conversation_id, path=path, sha256=sha256, size=len(updated),
                       agent_slug=agent_slug, run_id=run_id),
            )
            await self._collect_garbage(conn, user_id, [row["sha256"]])
        return True

    # -- whole conversations -------------------------------------------------
    async def copy_conversation(self, user_id: str, source_id: str, target_id: str) -> int:
        """Give ``target_id`` every file ``source_id`` has — rows only, no bytes.

        The new rows name the same blobs, so a fork costs a few hundred bytes
        per file however large the files are. Paths the target already has are
        kept, so a retried copy changes nothing.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "INSERT INTO conversation_files "
                "(conversation_id, path, user_id, sha256, size_bytes, agent_slug, source_run_id, "
                "created_at, updated_at) "
                "SELECT %(target)s, path, user_id, sha256, size_bytes, agent_slug, source_run_id, "
                "created_at, updated_at FROM conversation_files "
                "WHERE conversation_id = %(source)s AND user_id = %(user_id)s "
                "ON CONFLICT (conversation_id, path) DO NOTHING",
                {"user_id": user_id, "source": source_id, "target": target_id},
            )
            copied = cur.rowcount or 0
        logger.info("conversation_files_copied", "Copied a conversation's files to its fork", files=copied)
        return copied

    async def delete_conversation(self, user_id: str, conversation_id: str) -> tuple[int, int]:
        """Delete every file of one conversation. Returns ``(files, bytes)``."""
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                f"DELETE FROM conversation_files WHERE {_SCOPE} RETURNING sha256, size_bytes",
                _scope(user_id, conversation_id),
            )
            rows = await cur.fetchall()
            await self._collect_garbage(conn, user_id, sorted({row["sha256"] for row in rows}))
        removed = sum(int(row["size_bytes"]) for row in rows)
        logger.info("conversation_files_reaped", "Deleted a conversation's files",
                    files=len(rows), bytes=removed)
        return len(rows), removed

    async def purge_user(self, user_id: str) -> dict[str, int]:
        """Account deletion: every file and blob the user has, in one transaction."""
        async with self._pool.connection() as conn, conn.transaction():
            files = await conn.execute("DELETE FROM conversation_files WHERE user_id = %s", (user_id,))
            blobs = await conn.execute("DELETE FROM conversation_file_blobs WHERE user_id = %s", (user_id,))
        counts = {"conversation_files": files.rowcount or 0, "conversation_file_blobs": blobs.rowcount or 0}
        logger.info("conversation_files_purged", "Deleted a user's conversation files", **counts)
        return counts

    # -- internals -----------------------------------------------------------
    async def _conflict(
        self, conn: Any, user_id: str, conversation_id: str, path: str, *, allow_existing: bool
    ) -> WriteOutcome | None:
        """Why ``path`` cannot take a file: an ancestor is a file, it is a
        directory, or (unless ``allow_existing``) it is already a file."""
        lower, upper = paths.children_range(path)
        probes = paths.ancestors(path) + ([] if allow_existing else [path])
        cur = await conn.execute(
            f"SELECT path FROM conversation_files WHERE {_SCOPE} "
            "AND (path = ANY(%(probes)s) OR (path >= %(lower)s AND path < %(upper)s)) LIMIT 1",
            _scope(user_id, conversation_id, probes=probes, lower=lower, upper=upper),
        )
        row = await cur.fetchone()
        if row is None:
            return None
        if row["path"] == path:
            return "exists"
        return "is_directory" if row["path"].startswith(lower) else "parent_is_file"

    async def _save_blob(self, conn: Any, user_id: str, data: bytes) -> str:
        """Make sure the blob for ``data`` exists and stays until this commit.

        An existing blob is locked ``FOR KEY SHARE`` — the lock a foreign key
        takes — so a concurrent garbage collection cannot delete it between now
        and the row that will name it. Only a new blob is encrypted and sent.
        """
        sha256 = hashlib.sha256(data).hexdigest()
        cur = await conn.execute(
            "SELECT 1 FROM conversation_file_blobs WHERE user_id = %s AND sha256 = %s FOR KEY SHARE",
            (user_id, sha256),
        )
        if await cur.fetchone() is None:
            cipher, stored = self._cipher.encrypt(data)
            await conn.execute(
                "INSERT INTO conversation_file_blobs (user_id, sha256, size_bytes, cipher, data) "
                "VALUES (%s, %s, %s, %s, %s) "
                # DO UPDATE, not DO NOTHING: it locks a blob a racing writer just
                # added, which DO NOTHING would leave unprotected.
                "ON CONFLICT (user_id, sha256) DO UPDATE SET size_bytes = EXCLUDED.size_bytes",
                (user_id, sha256, len(data), cipher, stored),
            )
        return sha256

    async def _collect_garbage(self, conn: Any, user_id: str, sha256s: list[str]) -> None:
        """Delete the blobs among ``sha256s`` that no file names any more.

        Runs in a savepoint inside the caller's transaction, so it sees the
        caller's own deletes. When a concurrent write picks a blob up between
        the "unreferenced?" probe and the delete, the foreign key refuses the
        delete; the retry is a fresh statement that sees the new reference and
        leaves that blob alone.
        """
        if not sha256s:
            return
        for _ in range(_GC_ATTEMPTS):
            try:
                async with conn.transaction():
                    await conn.execute(
                        "DELETE FROM conversation_file_blobs b "
                        "WHERE b.user_id = %s AND b.sha256 = ANY(%s) AND NOT EXISTS ("
                        "SELECT 1 FROM conversation_files f WHERE f.user_id = b.user_id AND f.sha256 = b.sha256)",
                        (user_id, sha256s),
                    )
                return
            except psycopg.errors.ForeignKeyViolation:
                continue
        logger.warning("conversation_blob_gc_deferred",
                       "Left blobs in place that concurrent writes kept referencing", blobs=len(sha256s))
