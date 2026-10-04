"""Skills, stored in ``agent_runtime`` — no per-user filesystem underneath.

A user's skills used to live as directories on the agents volume, with a second
copy of the same bytes in ``chat_db`` and a 900-second loop reading, hashing and
reconciling both for **every user** whether or not anything had changed. That is
``O(content x users)` forever, so it does not degrade gracefully — it degrades
linearly with signups.

They now live in this database, and ``/skills/`` and ``/default_skills/`` are
*virtual* routes over it. There is one copy, so there is nothing to reconcile.

**Why ``agent_runtime`` and not ``chat_db``:** the consumer owns the store. An
agent reads its skills on every run; the Skills tab reads them when somebody
opens it. Keeping them in this service's own database makes the hot path a local
read and leaves the rare path as the HTTP call the bridge already makes — the
exact shape ``/memories/`` has, mirrored rather than reinvented.

**This store is also the resolver.** A pool entry is one of two kinds and only
one of them has rows here:

* ``custom`` — the user authored it; the bytes are in ``skill_files``.
* ``global`` — **legacy**: a *reference* into the bundled catalogue plan 30
  deleted from the image. No rows, no copy; reads are still served from
  ``global/skills/<category>/<name>/`` on the volume so an entry a user holds
  keeps working until it is pruned. Nothing creates one any more.

* ``remote`` — added from a remote source (plan 30). Also a pointer, into a
  **shared, immutable** copy in ``remote_skill_files`` keyed by the skill's
  content, so a skill a hundred users add is stored once and never changes
  under any of them.

Doing that dispatch inside the store means the mount stays one plain
``StoreBackend`` and inherits its directory synthesis (``ls`` splits keys on
``/`` and reports the first segment with ``is_dir=True``), which is what
``SkillsMiddleware`` discovery needs. No bespoke backend, no new contract.

**The catalogue lives here too.** ``skill_catalogue`` indexes every remote
skill the sync has seen, so one full-text query answers the Skills tab's search.
Refused skills are kept as rows with their reason — that is what lets the next
sync skip re-reading them — and are never returned by a search or accepted by
an Add.
"""
from __future__ import annotations

import asyncio
import base64
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncGenerator, Iterable, Optional

from langgraph.store.base import (
    BaseStore,
    GetOp,
    Item,
    ListNamespacesOp,
    PutOp,
    Result,
    SearchItem,
    SearchOp,
)

from core.logging import get_logger
from harness.filesystem import layout

logger = get_logger(__name__)

#: Pool entry kinds. ``GLOBAL`` entries are pointers into the catalogue and
#: deliberately carry no ``skill_files`` rows.
POOL_TYPE_CUSTOM = "custom"
POOL_TYPE_GLOBAL = "global"
#: Added from a remote source; reads resolve into the shared pinned copy.
POOL_TYPE_REMOTE = "remote"

#: Session-level advisory lock key for the remote sync. Any constant works as
#: long as nothing else in `agent_runtime` uses it; this one spells "skil5".
_SYNC_LOCK_KEY = 0x736B696C35

#: Hard ceiling on a page of search results, whatever the caller asks for.
MAX_SEARCH_LIMIT = 50

#: Which mount a namespace addresses. ``ASSIGNED`` is tier ② — what the user
#: switched on for this agent. ``DECLARED`` is tier ① for a *user-authored*
#: agent — the skill set its spec names. A platform agent's tier ① is bundled in
#: its image folder and never reaches this store.
TIER_ASSIGNED = "assigned"
TIER_DECLARED = "declared"

#: The entry file every skill must have, and the only file discovery reads.
SKILL_ENTRY_FILE = "SKILL.md"

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

_DDL = """
CREATE TABLE IF NOT EXISTS skill_pool (
    user_id     text NOT NULL,
    skill_name  text NOT NULL,
    type        text NOT NULL DEFAULT 'custom',
    category    text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    -- Provenance. Only knowable at write time and not backfillable, which is
    -- why it is in the first version of this table rather than added later:
    -- `create_skill` lets an agent author a skill, and "who wrote this" is a
    -- review signal for content the model will later follow as instructions.
    origin           text NOT NULL DEFAULT 'user',
    created_by_agent text,
    added_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    PRIMARY KEY (user_id, skill_name)
);

CREATE TABLE IF NOT EXISTS skill_files (
    user_id     text NOT NULL,
    skill_name  text NOT NULL,
    path        text NOT NULL,
    content     text NOT NULL,
    encoding    text NOT NULL DEFAULT 'utf-8',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, skill_name, path)
);

CREATE TABLE IF NOT EXISTS agent_skills (
    user_id     text NOT NULL,
    agent_slug  text NOT NULL,
    skill_name  text NOT NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, agent_slug, skill_name)
);

-- `agent_runtime` has no alembic chain, so `CREATE TABLE IF NOT EXISTS` is the
-- only schema step — and it does nothing once the table exists. A column added
-- after a deployment has already booted would therefore never appear. These
-- keep the DDL genuinely idempotent: every column the code reads is asserted
-- here, not just in the CREATE above. Add a matching line with every new column.
ALTER TABLE skill_pool  ADD COLUMN IF NOT EXISTS origin           text NOT NULL DEFAULT 'user';
ALTER TABLE skill_pool  ADD COLUMN IF NOT EXISTS created_by_agent text;
ALTER TABLE skill_pool  ADD COLUMN IF NOT EXISTS description      text NOT NULL DEFAULT '';
ALTER TABLE skill_pool  ADD COLUMN IF NOT EXISTS deleted_at       timestamptz;
ALTER TABLE skill_files ADD COLUMN IF NOT EXISTS encoding         text NOT NULL DEFAULT 'utf-8';

-- Plan 30: remote entries point at a shared copy. `source_ref` is that copy's
-- content hash; `source_commit` is the upstream commit (or artifact digest) it
-- was fetched at, kept for provenance; `licence` is what the user was shown.
ALTER TABLE skill_pool  ADD COLUMN IF NOT EXISTS source_id        text;
ALTER TABLE skill_pool  ADD COLUMN IF NOT EXISTS source_ref       text;
ALTER TABLE skill_pool  ADD COLUMN IF NOT EXISTS source_commit    text;
ALTER TABLE skill_pool  ADD COLUMN IF NOT EXISTS licence          text;

CREATE TABLE IF NOT EXISTS remote_skill_sources (
    source_id      text PRIMARY KEY,
    source_ref     text NOT NULL DEFAULT '',
    synced_at      timestamptz,
    last_error     text,
    skill_count    integer NOT NULL DEFAULT 0,
    admitted_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_catalogue (
    source_id     text NOT NULL,
    skill_id      text NOT NULL,
    name          text NOT NULL,
    description   text NOT NULL DEFAULT '',
    category      text NOT NULL DEFAULT '',
    licence       text,
    risk          text,
    source_ref    text NOT NULL DEFAULT '',
    entry_path    text NOT NULL DEFAULT '',
    meta_sha      text NOT NULL DEFAULT '',
    content_ref   text NOT NULL DEFAULT '',
    artifact_url  text,
    artifact_type text,
    refusal       text,
    withdrawn_at  timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, skill_id)
);

CREATE TABLE IF NOT EXISTS remote_skill_manifest (
    source_id  text NOT NULL,
    skill_id   text NOT NULL,
    path       text NOT NULL,
    blob_sha   text NOT NULL,
    size       integer NOT NULL,
    PRIMARY KEY (source_id, skill_id, path)
);

CREATE TABLE IF NOT EXISTS remote_skill_files (
    source_id   text NOT NULL,
    skill_id    text NOT NULL,
    content_ref text NOT NULL,
    path        text NOT NULL,
    content     text NOT NULL,
    encoding    text NOT NULL DEFAULT 'utf-8',
    sha256      text NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, skill_id, content_ref, path)
);

-- Every column the search reads, asserted for a table created by an earlier
-- version of this DDL (same reason as the skill_pool lines above).
ALTER TABLE skill_catalogue ADD COLUMN IF NOT EXISTS refusal       text;
ALTER TABLE skill_catalogue ADD COLUMN IF NOT EXISTS content_ref   text NOT NULL DEFAULT '';
ALTER TABLE skill_catalogue ADD COLUMN IF NOT EXISTS artifact_type text;

-- The search vector: name and folder id weigh most, then category, then the
-- description. One configuration ('english') throughout, because a query is
-- parsed with one configuration and a mismatch silently matches nothing.
ALTER TABLE skill_catalogue ADD COLUMN IF NOT EXISTS search tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(name, '') || ' ' || replace(skill_id, '-', ' ')), 'A') ||
        setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'C')
    ) STORED;
CREATE INDEX IF NOT EXISTS skill_catalogue_search_idx ON skill_catalogue USING gin (search);
CREATE INDEX IF NOT EXISTS skill_catalogue_skill_id_idx ON skill_catalogue (skill_id);
"""

_COMMENTS = [
    "COMMENT ON TABLE skill_pool IS "
    "'One row per skill a user holds. type=global rows are references into the "
    "volume catalogue and carry no skill_files rows.'",
    "COMMENT ON TABLE skill_files IS "
    "'Content of user-authored (custom) skills. path is relative to the skill "
    "folder, e.g. SKILL.md or templates/plan.md.'",
    "COMMENT ON TABLE agent_skills IS "
    "'Tier 2: which pool skills the user switched on for which agent.'",
    "COMMENT ON TABLE skill_catalogue IS "
    "'Searchable index of platform + remote skills. refusal IS NOT NULL rows were "
    "seen but failed a gate; they are kept so the sync can skip re-reading them.'",
    "COMMENT ON TABLE remote_skill_manifest IS "
    "'File list of each remote skill at the catalogue commit: path, git blob sha, "
    "size. No content - it is what lets an Add verify every file.'",
    "COMMENT ON TABLE remote_skill_files IS "
    "'Shared, immutable copies of added remote skills, keyed by content hash.'",
    "COMMENT ON TABLE remote_skill_sources IS "
    "'One row per allowlisted source: last synced ref and outcome.'",
]

# The two column lists below are interpolated into SQL text. They are module
# constants and never carry input; every value still goes in as a bound parameter.
_POOL_COLUMNS = (
    "skill_name, type, category, description, origin, created_by_agent, added_at, "
    "source_id, source_ref, source_commit, licence"
)

_CATALOGUE_COLUMNS = (
    "source_id, skill_id, name, description, category, licence, risk, source_ref, "
    "entry_path, meta_sha, content_ref, artifact_url, artifact_type, refusal, withdrawn_at"
)


@dataclass(frozen=True)
class CatalogueEntry:
    """One row of ``skill_catalogue`` as the sync writes it.

    ``refusal`` is ``None`` for a skill that passed every gate; otherwise the
    short reason it was refused, and the row is invisible to search and Add.
    """

    skill_id: str
    name: str
    description: str = ""
    category: str = ""
    licence: Optional[str] = None
    risk: Optional[str] = None
    source_ref: str = ""
    entry_path: str = ""
    meta_sha: str = ""
    content_ref: str = ""
    artifact_url: Optional[str] = None
    artifact_type: Optional[str] = None
    refusal: Optional[str] = None


def _pool_row(row: Any) -> dict[str, Any]:
    """One ``skill_pool`` row as the shape the registry speaks.

    Rows arrive as mappings, not tuples: the pool this store borrows is built
    with ``row_factory=dict_row`` because the checkpointer requires it. The
    plan-30 columns are read with ``.get`` so a row from before they existed
    reads as a plain custom/global entry.
    """
    return {
        "name": row["skill_name"],
        "type": row["type"],
        "category": row["category"],
        "description": row["description"],
        "origin": row["origin"],
        "created_by_agent": row["created_by_agent"],
        "added_at": _utc(row["added_at"]),
        "source_id": row.get("source_id"),
        "source_ref": row.get("source_ref"),
        "source_commit": row.get("source_commit"),
        "licence": row.get("licence"),
    }


def _catalogue_row(row: Any) -> dict[str, Any]:
    """One ``skill_catalogue`` row as a plain dict."""
    return {key: row.get(key) for key in _CATALOGUE_COLUMNS.split(", ")}


def _utc(value: Any) -> datetime:
    """Normalise a DB timestamp to an aware UTC datetime."""
    if not isinstance(value, datetime):
        return _EPOCH
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def catalogue_dir(category: str, skill_name: str) -> Path:
    """On-disk folder of a legacy catalogue skill.

    The image no longer ships the bundled catalogue (plan 30), but what an
    earlier image seeded is still on the volume, and a ``global`` pool entry
    reads from there until it is pruned.
    """
    return layout.global_skills_root() / category / skill_name


class SkillStore(BaseStore):
    """``BaseStore`` over the skill tables, scoped by namespace.

    Namespace is ``(user_id, agent_slug, tier)``. Two mounts share one store and
    differ only by tier, so ``/skills/`` and ``/default_skills/`` cannot see each
    other's entries even though they read the same tables.

    Keys are **route-relative absolute paths** — ``/<skill>/SKILL.md`` — with the
    mount prefix already stripped by ``CompositeBackend``. The leading slash is
    load-bearing: ``StoreBackend.ls`` prefix-matches on it and reports the key
    verbatim as the file path, so a relative key is invisible to ``ls``/``glob``.

    Only :meth:`abatch` is abstract on ``BaseStore`` — ``get``/``search`` and
    friends are defined in terms of it — so the read surface here is small
    despite backing a full file API.
    """

    supports_ttl = False

    def __init__(self, pool: Any) -> None:
        self._pool = pool
        # Captured for the sync `batch` bridge below. Safe to take here: every
        # construction site (the mount factory, the skill routes) runs on the
        # service's event loop.
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

    # -- schema -----------------------------------------------------------
    async def setup(self) -> None:
        """Create the tables if absent.

        ``agent_runtime`` has no alembic chain; DDL-on-boot is the convention the
        checkpointer established and agent memory follows. The trade is
        deliberate: no versioned history for these tables.
        """
        async with self._pool.connection() as conn:
            await conn.execute(_DDL)
            for statement in _COMMENTS:
                await conn.execute(statement)

    # -- pool CRUD (used by the skill routes) ------------------------------
    async def list_pool(self, user_id: str) -> list[dict[str, Any]]:
        """Every live pool entry for this user, newest name order stable."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_POOL_COLUMNS} "
                "FROM skill_pool WHERE user_id = %s AND deleted_at IS NULL "
                "ORDER BY skill_name",
                (user_id,),
            )
            rows = await cur.fetchall()
        return [_pool_row(row) for row in rows]

    async def get_pool_entry(self, user_id: str, skill_name: str) -> Optional[dict[str, Any]]:
        """One live pool entry, or ``None`` when the user does not hold it."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_POOL_COLUMNS} "
                "FROM skill_pool WHERE user_id = %s AND skill_name = %s "
                "AND deleted_at IS NULL",
                (user_id, skill_name),
            )
            row = await cur.fetchone()
        return None if row is None else _pool_row(row)

    async def add_global(
        self, user_id: str, skill_name: str, *, category: str, description: str = ""
    ) -> None:
        """Reference a catalogue skill. No content is copied — that is the point."""
        async with self._pool.connection() as conn:
            await conn.execute(
                "INSERT INTO skill_pool (user_id, skill_name, type, category, description, "
                "added_at, deleted_at) VALUES (%s, %s, %s, %s, %s, now(), NULL) "
                "ON CONFLICT (user_id, skill_name) DO UPDATE SET "
                "type = EXCLUDED.type, category = EXCLUDED.category, "
                "description = EXCLUDED.description, deleted_at = NULL",
                (user_id, skill_name, POOL_TYPE_GLOBAL, category, description),
            )

    async def add_custom(
        self,
        user_id: str,
        skill_name: str,
        *,
        files: dict[str, tuple[str, str]],
        description: str = "",
        origin: str = "user",
        created_by_agent: str | None = None,
    ) -> None:
        """Create or replace a user-authored skill and all of its files.

        ``files`` maps a relative path to ``(content, encoding)``. A skill folder
        may carry binary assets, so the encoding travels with the bytes rather
        than being guessed from the extension on read.

        Replace, not merge: a save carries the whole folder, so a file the user
        removed must not survive as a leftover row.
        """
        async with self._pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    "INSERT INTO skill_pool (user_id, skill_name, type, category, "
                    "description, origin, created_by_agent, added_at, deleted_at) "
                    "VALUES (%s, %s, %s, '', %s, %s, %s, now(), NULL) "
                    "ON CONFLICT (user_id, skill_name) DO UPDATE SET "
                    "type = EXCLUDED.type, description = EXCLUDED.description, "
                    "origin = EXCLUDED.origin, "
                    "created_by_agent = EXCLUDED.created_by_agent, "
                    "deleted_at = NULL",
                    (user_id, skill_name, POOL_TYPE_CUSTOM, description, origin,
                     created_by_agent),
                )
                await conn.execute(
                    "DELETE FROM skill_files WHERE user_id = %s AND skill_name = %s",
                    (user_id, skill_name),
                )
                for path, (content, encoding) in files.items():
                    await conn.execute(
                        "INSERT INTO skill_files "
                        "(user_id, skill_name, path, content, encoding) "
                        "VALUES (%s, %s, %s, %s, %s)",
                        (user_id, skill_name, path, content, encoding),
                    )

    async def add_remote(
        self,
        user_id: str,
        skill_name: str,
        *,
        source_id: str,
        content_ref: str,
        source_commit: str,
        licence: Optional[str],
        category: str = "",
        description: str = "",
        files: Optional[dict[str, tuple[str, str, str]]] = None,
    ) -> None:
        """Reference a remote skill's shared copy, writing the copy first if new.

        ``files`` maps a relative path to ``(content, encoding, sha256)`` and is
        ``None`` when the copy already exists (someone added this skill at this
        content before), in which case the Add is a single row — O(1), like a
        global entry. Copy and pool row commit together or not at all.

        ``ON CONFLICT DO NOTHING`` on the copy makes two users adding the same
        skill at once safe: identical content under an identical key.
        """
        async with self._pool.connection() as conn:
            async with conn.transaction():
                if files:
                    async with conn.cursor() as cur:
                        await cur.executemany(
                            "INSERT INTO remote_skill_files "
                            "(source_id, skill_id, content_ref, path, content, encoding, sha256) "
                            "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                            [
                                (source_id, skill_name, content_ref, path, content, encoding, digest)
                                for path, (content, encoding, digest) in sorted(files.items())
                            ],
                        )
                await conn.execute(
                    "INSERT INTO skill_pool (user_id, skill_name, type, category, description, "
                    "origin, created_by_agent, source_id, source_ref, source_commit, licence, "
                    "added_at, deleted_at) "
                    "VALUES (%s, %s, %s, %s, %s, 'user', NULL, %s, %s, %s, %s, now(), NULL) "
                    "ON CONFLICT (user_id, skill_name) DO UPDATE SET "
                    "type = EXCLUDED.type, category = EXCLUDED.category, "
                    "description = EXCLUDED.description, origin = EXCLUDED.origin, "
                    "created_by_agent = NULL, source_id = EXCLUDED.source_id, "
                    "source_ref = EXCLUDED.source_ref, source_commit = EXCLUDED.source_commit, "
                    "licence = EXCLUDED.licence, added_at = now(), deleted_at = NULL",
                    (user_id, skill_name, POOL_TYPE_REMOTE, category, description,
                     source_id, content_ref, source_commit, licence),
                )

    async def has_remote_copy(self, source_id: str, skill_id: str, content_ref: str) -> bool:
        """Whether a shared copy of this exact content is already stored."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT 1 FROM remote_skill_files "
                "WHERE source_id = %s AND skill_id = %s AND content_ref = %s LIMIT 1",
                (source_id, skill_id, content_ref),
            )
            return await cur.fetchone() is not None

    async def remove(self, user_id: str, skill_name: str) -> bool:
        """Drop a skill from the pool, its files, and every agent assignment.

        Tombstoned rather than deleted so a name the user removed does not come
        back from a stale read. Returns whether anything was held.
        """
        async with self._pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(
                    "UPDATE skill_pool SET deleted_at = now() "
                    "WHERE user_id = %s AND skill_name = %s AND deleted_at IS NULL",
                    (user_id, skill_name),
                )
                removed = cur.rowcount > 0
                await conn.execute(
                    "DELETE FROM skill_files WHERE user_id = %s AND skill_name = %s",
                    (user_id, skill_name),
                )
                # Cascade: an assignment to a skill the user no longer holds
                # would mount a folder with nothing behind it.
                await conn.execute(
                    "DELETE FROM agent_skills WHERE user_id = %s AND skill_name = %s",
                    (user_id, skill_name),
                )
        return removed

    # -- per-agent assignment ---------------------------------------------
    async def list_agent_skills(self, user_id: str, agent_slug: str) -> list[str]:
        """Skill names this user switched on for this agent (tier ②)."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT a.skill_name FROM agent_skills a "
                "JOIN skill_pool p ON p.user_id = a.user_id AND p.skill_name = a.skill_name "
                "WHERE a.user_id = %s AND a.agent_slug = %s AND p.deleted_at IS NULL "
                "ORDER BY a.skill_name",
                (user_id, agent_slug),
            )
            rows = await cur.fetchall()
        return [row["skill_name"] for row in rows]

    async def assign(self, user_id: str, agent_slug: str, skill_name: str) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                "INSERT INTO agent_skills (user_id, agent_slug, skill_name) "
                "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                (user_id, agent_slug, skill_name),
            )

    async def unassign(self, user_id: str, agent_slug: str, skill_name: str) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                "DELETE FROM agent_skills "
                "WHERE user_id = %s AND agent_slug = %s AND skill_name = %s",
                (user_id, agent_slug, skill_name),
            )

    # -- file reads (the mount) -------------------------------------------
    async def read_files(
        self, user_id: str, skill_name: str
    ) -> dict[str, tuple[str, str]]:
        """Every file of one skill as ``{relative path: (content, encoding)}``.

        Dispatches on the entry's kind: a custom skill's bytes are rows here, a
        global entry's are read from the catalogue on the volume, and a remote
        entry's from the shared copy its ``source_ref`` pins.
        """
        entry = await self.get_pool_entry(user_id, skill_name)
        if entry is None:
            return {}
        if entry["type"] == POOL_TYPE_GLOBAL:
            return _read_catalogue_files(entry["category"], skill_name)
        if entry["type"] == POOL_TYPE_REMOTE:
            return await self.read_remote_copy(
                entry.get("source_id") or "", skill_name, entry.get("source_ref") or ""
            )

        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT path, content, encoding FROM skill_files "
                "WHERE user_id = %s AND skill_name = %s ORDER BY path",
                (user_id, skill_name),
            )
            rows = await cur.fetchall()
        return {row["path"]: (row["content"], row["encoding"]) for row in rows}

    async def read_remote_copy(
        self, source_id: str, skill_id: str, content_ref: str
    ) -> dict[str, tuple[str, str]]:
        """The files of one shared remote copy, as ``{path: (content, encoding)}``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT path, content, encoding FROM remote_skill_files "
                "WHERE source_id = %s AND skill_id = %s AND content_ref = %s ORDER BY path",
                (source_id, skill_id, content_ref),
            )
            rows = await cur.fetchall()
        return {row["path"]: (row["content"], row["encoding"]) for row in rows}

    # -- catalogue: sync side ----------------------------------------------
    @asynccontextmanager
    async def sync_lock(self) -> AsyncGenerator[bool, None]:
        """Hold the sync's advisory lock for the duration of the block.

        Yields whether the lock was taken. Session-level, on one checked-out
        connection, so it is released when that connection's block exits even
        if the pass raises — and two replicas can never sync at once.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute("SELECT pg_try_advisory_lock(%s) AS taken", (_SYNC_LOCK_KEY,))
            row = await cur.fetchone()
            taken = bool(row and row["taken"])
            try:
                yield taken
            finally:
                if taken:
                    await conn.execute("SELECT pg_advisory_unlock(%s)", (_SYNC_LOCK_KEY,))

    async def get_source_state(self, source_id: str) -> Optional[dict[str, Any]]:
        """What the last sync of this source recorded, or ``None`` if never synced."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT source_id, source_ref, synced_at, last_error, skill_count, admitted_count "
                "FROM remote_skill_sources WHERE source_id = %s",
                (source_id,),
            )
            row = await cur.fetchone()
        return None if row is None else dict(row)

    async def list_source_states(self) -> list[dict[str, Any]]:
        """Every source's last sync outcome — the ops view."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT source_id, source_ref, synced_at, last_error, skill_count, admitted_count "
                "FROM remote_skill_sources ORDER BY source_id"
            )
            rows = await cur.fetchall()
        return [dict(row) for row in rows]

    async def list_catalogue(self, source_id: str) -> dict[str, dict[str, Any]]:
        """Every row this source has, refused ones included, keyed by skill id.

        The sync reads it to decide which skills changed: a row whose
        ``meta_sha`` still matches upstream is reused without a single read.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_CATALOGUE_COLUMNS} FROM skill_catalogue WHERE source_id = %s",
                (source_id,),
            )
            rows = await cur.fetchall()
        return {row["skill_id"]: _catalogue_row(row) for row in rows}

    async def apply_source_sync(
        self,
        source_id: str,
        *,
        source_ref: str,
        entries: list[CatalogueEntry],
        manifests: Optional[dict[str, list[tuple[str, str, int]]]],
        record_state: bool = True,
    ) -> None:
        """Replace this source's slice of the catalogue, in one transaction.

        * Every entry is upserted and un-withdrawn.
        * A row the pass did not see is **withdrawn, not deleted**: users who
          hold that skill keep their pinned copy, and nobody new can add it.
        * ``manifests`` (``skill_id → [(path, blob_sha, size)]``) replaces the
          source's file lists wholesale; ``None`` leaves them alone (a source
          with no per-file manifest, or the platform's own catalogue).

        Either all of it lands or none of it does — a sync never leaves the
        catalogue half-updated for a search to read.
        """
        seen = [entry.skill_id for entry in entries]
        admitted = sum(1 for entry in entries if entry.refusal is None)
        async with self._pool.connection() as conn:
            async with conn.transaction():
                async with conn.cursor() as cur:
                    if entries:
                        await cur.executemany(
                            "INSERT INTO skill_catalogue (source_id, skill_id, name, description, "
                            "category, licence, risk, source_ref, entry_path, meta_sha, content_ref, "
                            "artifact_url, artifact_type, refusal, withdrawn_at, updated_at) "
                            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, now()) "
                            "ON CONFLICT (source_id, skill_id) DO UPDATE SET "
                            "name = EXCLUDED.name, description = EXCLUDED.description, "
                            "category = EXCLUDED.category, licence = EXCLUDED.licence, "
                            "risk = EXCLUDED.risk, source_ref = EXCLUDED.source_ref, "
                            "entry_path = EXCLUDED.entry_path, meta_sha = EXCLUDED.meta_sha, "
                            "content_ref = EXCLUDED.content_ref, artifact_url = EXCLUDED.artifact_url, "
                            "artifact_type = EXCLUDED.artifact_type, refusal = EXCLUDED.refusal, "
                            "withdrawn_at = NULL, updated_at = now()",
                            [
                                (source_id, e.skill_id, e.name, e.description, e.category,
                                 e.licence, e.risk, e.source_ref, e.entry_path, e.meta_sha,
                                 e.content_ref, e.artifact_url, e.artifact_type, e.refusal)
                                for e in entries
                            ],
                        )
                    await cur.execute(
                        "UPDATE skill_catalogue SET withdrawn_at = now(), updated_at = now() "
                        "WHERE source_id = %s AND withdrawn_at IS NULL "
                        "AND NOT (skill_id = ANY(%s))",
                        (source_id, seen),
                    )
                    if manifests is not None:
                        await cur.execute(
                            "DELETE FROM remote_skill_manifest WHERE source_id = %s", (source_id,)
                        )
                        rows = [
                            (source_id, skill_id, path, blob_sha, size)
                            for skill_id, files in manifests.items()
                            for path, blob_sha, size in files
                        ]
                        if rows:
                            await cur.executemany(
                                "INSERT INTO remote_skill_manifest "
                                "(source_id, skill_id, path, blob_sha, size) "
                                "VALUES (%s, %s, %s, %s, %s)",
                                rows,
                            )
                    if record_state:
                        await cur.execute(
                            "INSERT INTO remote_skill_sources (source_id, source_ref, synced_at, "
                            "last_error, skill_count, admitted_count) "
                            "VALUES (%s, %s, now(), NULL, %s, %s) "
                            "ON CONFLICT (source_id) DO UPDATE SET source_ref = EXCLUDED.source_ref, "
                            "synced_at = now(), last_error = NULL, "
                            "skill_count = EXCLUDED.skill_count, admitted_count = EXCLUDED.admitted_count",
                            (source_id, source_ref, len(entries), admitted),
                        )

    async def record_source_error(self, source_id: str, reason: str) -> None:
        """Note a failed pass without touching the catalogue.

        The previous rows stay exactly as they were — a source that cannot be
        read keeps serving its last good catalogue rather than going empty.
        """
        async with self._pool.connection() as conn:
            await conn.execute(
                "INSERT INTO remote_skill_sources (source_id, last_error, synced_at) "
                "VALUES (%s, %s, now()) "
                "ON CONFLICT (source_id) DO UPDATE SET last_error = EXCLUDED.last_error, "
                "synced_at = now()",
                (source_id, reason[:200]),
            )

    # -- catalogue: read side -----------------------------------------------
    async def get_catalogue_entry(self, source_id: str, skill_id: str) -> Optional[dict[str, Any]]:
        """One catalogue row, whatever its state — the caller checks refusal/withdrawal."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_CATALOGUE_COLUMNS} FROM skill_catalogue "
                "WHERE source_id = %s AND skill_id = %s",
                (source_id, skill_id),
            )
            row = await cur.fetchone()
        return None if row is None else _catalogue_row(row)

    async def get_manifest(self, source_id: str, skill_id: str) -> list[tuple[str, str, int]]:
        """``(path, blob_sha, size)`` for every file of one remote skill."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT path, blob_sha, size FROM remote_skill_manifest "
                "WHERE source_id = %s AND skill_id = %s ORDER BY path",
                (source_id, skill_id),
            )
            rows = await cur.fetchall()
        return [(row["path"], row["blob_sha"], int(row["size"])) for row in rows]

    async def search_catalogue(
        self,
        terms: list[str],
        *,
        source_ids: list[str],
        limit: int = 10,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """Rank admitted, live catalogue rows against ``terms``; ``(rows, total)``.

        Each term is a prefix match (``react:*``), so results appear while the
        user is still typing, and terms are OR-ed: ``ts_rank_cd`` already puts a
        row matching more of them first. An exact folder-id hit is pinned to the
        top. With no terms it is an alphabetical browse.

        ``terms`` must already be sanitised by :func:`catalogue_query_terms` —
        it is what keeps the tsquery syntactically valid; the value still goes
        in as a bound parameter, never into the SQL text. ``source_ids`` is the
        allowlist to search within, so rows a removed source left behind are
        never returned.
        """
        limit = max(1, min(limit, MAX_SEARCH_LIMIT))
        offset = max(0, offset)
        params: dict[str, Any] = {"sources": source_ids, "limit": limit, "offset": offset}
        live = (
            "c.refusal IS NULL AND c.withdrawn_at IS NULL "
            "AND c.source_id = ANY(%(sources)s)"
        )
        if terms:
            params["tsq"] = " | ".join(f"{term}:*" for term in terms)
            params["exact"] = "-".join(terms)
            sql = (
                f"SELECT {_CATALOGUE_COLUMNS}, count(*) OVER () AS total "
                "FROM skill_catalogue c, to_tsquery('english', %(tsq)s) q "
                f"WHERE {live} AND c.search @@ q "
                "ORDER BY (c.skill_id = %(exact)s) DESC, ts_rank_cd(c.search, q) DESC, c.skill_id "
                "LIMIT %(limit)s OFFSET %(offset)s"
            )
        else:
            sql = (
                f"SELECT {_CATALOGUE_COLUMNS}, count(*) OVER () AS total "
                f"FROM skill_catalogue c WHERE {live} "
                "ORDER BY c.skill_id, c.source_id LIMIT %(limit)s OFFSET %(offset)s"
            )
        async with self._pool.connection() as conn:
            cur = await conn.execute(sql, params)
            rows = await cur.fetchall()
        total = int(rows[0]["total"]) if rows else 0
        return [_catalogue_row(row) for row in rows], total

    # -- export (plan 27): pages and slices, never a whole user at once ------
    async def page_pool_entries(self, user_id: str, after_name: str, limit: int) -> list[dict[str, Any]]:
        """One page of the user's live pool entries, keyed after ``after_name``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_POOL_COLUMNS} FROM skill_pool "
                "WHERE user_id = %s AND deleted_at IS NULL AND skill_name > %s "
                "ORDER BY skill_name LIMIT %s",
                (user_id, after_name, limit),
            )
            rows = await cur.fetchall()
        return [_pool_row(row) for row in rows]

    async def page_custom_file_refs(
        self, user_id: str, after: tuple[str, str], limit: int
    ) -> list[dict[str, Any]]:
        """One page of ``(skill_name, path, encoding)`` for the user's **custom**
        skills only. Remote and legacy entries carry no files of their own —
        they are exported as references, never as third-party content."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT f.skill_name, f.path, f.encoding FROM skill_files f "
                "JOIN skill_pool p ON p.user_id = f.user_id AND p.skill_name = f.skill_name "
                "WHERE f.user_id = %s AND p.deleted_at IS NULL AND p.type = %s "
                "AND (f.skill_name, f.path) > (%s, %s) "
                "ORDER BY f.skill_name, f.path LIMIT %s",
                (user_id, POOL_TYPE_CUSTOM, after[0], after[1], limit),
            )
            return list(await cur.fetchall())

    async def read_custom_file_slice(
        self, user_id: str, skill_name: str, path: str, start: int, length: int
    ) -> str:
        """``length`` characters of one custom-skill file from 1-based ``start``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT substring(content from %s for %s) AS part FROM skill_files "
                "WHERE user_id = %s AND skill_name = %s AND path = %s",
                (start, length, user_id, skill_name, path),
            )
            row = await cur.fetchone()
        return (row["part"] or "") if row else ""

    async def page_assignments(
        self, user_id: str, after: tuple[str, str], limit: int
    ) -> list[dict[str, Any]]:
        """One page of ``(agent_slug, skill_name, assigned_at)`` for live skills."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT a.agent_slug, a.skill_name, a.assigned_at FROM agent_skills a "
                "JOIN skill_pool p ON p.user_id = a.user_id AND p.skill_name = a.skill_name "
                "WHERE a.user_id = %s AND p.deleted_at IS NULL "
                "AND (a.agent_slug, a.skill_name) > (%s, %s) "
                "ORDER BY a.agent_slug, a.skill_name LIMIT %s",
                (user_id, after[0], after[1], limit),
            )
            return list(await cur.fetchall())

    async def _names_for(self, namespace: tuple[str, ...]) -> list[str]:
        """Skill names a namespace exposes.

        ``assigned`` is the per-agent tier ② list. ``declared`` is tier ① for a
        user-authored agent: the spec's names, handed in by the caller through
        the namespace so this store never has to read an agent definition.
        """
        user_id, agent_slug, tier = namespace[0], namespace[1], namespace[2]
        if tier == TIER_ASSIGNED:
            return await self.list_agent_skills(user_id, agent_slug)
        # DECLARED carries its names in the namespace tail: the resolver knows
        # the spec, this store knows the content, and neither needs the other's
        # source.
        return [name for name in namespace[3:] if name]

    async def _files_for(self, namespace: tuple[str, ...]) -> dict[str, tuple[str, str]]:
        """Every file the namespace exposes, keyed by route-relative path."""
        user_id = namespace[0]
        out: dict[str, tuple[str, str]] = {}
        for name in await self._names_for(namespace):
            for rel_path, payload in (await self.read_files(user_id, name)).items():
                out[f"/{name}/{rel_path}"] = payload
        return out

    # -- the one abstract method ------------------------------------------
    async def abatch(self, ops: Iterable[Any]) -> list[Result]:
        results: list[Result] = []
        for op in ops:
            if isinstance(op, GetOp):
                results.append(await self._get(op))
            elif isinstance(op, SearchOp):
                results.append(await self._search(op))
            elif isinstance(op, PutOp):
                # The mount is read-only — `/skills/` is write-denied by the
                # permission ladder — so a write reaching here is a bug
                # elsewhere, not a case to support silently.
                logger.warning(
                    "skill_store_write_ignored",
                    "Ignored a write to the read-only skills mount",
                    key=getattr(op, "key", ""),
                )
                results.append(None)
            elif isinstance(op, ListNamespacesOp):
                results.append([])
            else:
                results.append(None)
        return results

    def batch(self, ops: Iterable[Any]) -> list[Result]:
        """Sync bridge, as ``AgentMemoryStore`` does it.

        ``BaseStore`` requires both faces. Everything here is async, so the sync
        one hands the work to the loop this store was built on rather than
        opening a second connection path.
        """
        if self._loop is None or not self._loop.is_running():
            return asyncio.run(self.abatch(ops))
        future = asyncio.run_coroutine_threadsafe(self.abatch(list(ops)), self._loop)
        return future.result()

    # -- read helpers ------------------------------------------------------
    async def _get(self, op: GetOp) -> Optional[Item]:
        files = await self._files_for(tuple(op.namespace))
        payload = files.get(op.key)
        if payload is None:
            return None
        return _as_item(tuple(op.namespace), op.key, *payload)

    async def _search(self, op: SearchOp) -> list[SearchItem]:
        files = await self._files_for(tuple(op.namespace_prefix))
        items = [
            _as_search_item(tuple(op.namespace_prefix), key, *payload)
            for key, payload in sorted(files.items())
        ]
        offset = op.offset or 0
        limit = op.limit if op.limit is not None else len(items)
        return items[offset : offset + limit]


_TERM_RE = re.compile(r"[a-z0-9]+")
_MAX_QUERY_TERMS = 8


def catalogue_query_terms(query: str) -> list[str]:
    """Reduce a free-text query to safe tsquery terms.

    Lowercase ASCII alphanumerics only, 2-32 characters, at most eight. That is
    what makes ``term:*`` always a valid tsquery fragment: no operator, quote or
    backslash can survive, so a typed ``&`` or ``'`` cannot turn the search into
    a syntax error (it is a bound parameter either way — this is about the
    query parsing, not injection).
    """
    terms: list[str] = []
    for term in _TERM_RE.findall((query or "").lower()):
        if 2 <= len(term) <= 32 and term not in terms:
            terms.append(term)
        if len(terms) == _MAX_QUERY_TERMS:
            break
    return terms


def _read_catalogue_files(category: str, skill_name: str) -> dict[str, tuple[str, str]]:
    """Read a catalogue skill's folder off the volume.

    Best-effort by design: a catalogue entry can disappear between image builds
    while a user still references it, and an unreadable file must not fail a run
    — the skill simply has one fewer file, or none at all.
    """
    root = catalogue_dir(category, skill_name)
    if not root.is_dir():
        return {}
    out: dict[str, tuple[str, str]] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        try:
            out[rel] = (path.read_text(encoding="utf-8"), "utf-8")
        except UnicodeDecodeError:
            # A catalogue skill may ship an image or a PDF beside SKILL.md.
            try:
                out[rel] = (base64.b64encode(path.read_bytes()).decode("ascii"), "base64")
            except OSError:
                continue
        except OSError:
            continue
    return out


def _as_item(namespace: tuple[str, ...], key: str, content: str, encoding: str) -> Item:
    """Wrap content in the shape ``StoreBackend`` expects to read a file from.

    ``encoding`` rides along so a binary asset round-trips — the file layer
    reads it to decide whether the payload is text or base64.
    """
    now = datetime.now(timezone.utc)
    return Item(
        namespace=namespace,
        key=key,
        value={"content": content, "encoding": encoding, "modified_at": now.isoformat()},
        created_at=now,
        updated_at=now,
    )


def _as_search_item(
    namespace: tuple[str, ...], key: str, content: str, encoding: str
) -> SearchItem:
    now = datetime.now(timezone.utc)
    return SearchItem(
        namespace=namespace,
        key=key,
        value={"content": content, "encoding": encoding, "modified_at": now.isoformat()},
        created_at=now,
        updated_at=now,
    )


__all__ = [
    "CatalogueEntry",
    "MAX_SEARCH_LIMIT",
    "POOL_TYPE_CUSTOM",
    "POOL_TYPE_GLOBAL",
    "POOL_TYPE_REMOTE",
    "SKILL_ENTRY_FILE",
    "TIER_ASSIGNED",
    "TIER_DECLARED",
    "SkillStore",
    "catalogue_dir",
    "catalogue_query_terms",
]
