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
* ``global`` — a *reference* to the platform catalogue, which stays on the
  volume as build-time content. No rows, no copy; reads are served from
  ``global/skills/<category>/<name>/`` at query time.

Doing that dispatch inside the store means the mount stays one plain
``StoreBackend`` and inherits its directory synthesis (``ls`` splits keys on
``/`` and reports the first segment with ``is_dir=True``), which is what
``SkillsMiddleware`` discovery needs. No bespoke backend, no new contract.
"""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

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
]


def _pool_row(row: Any) -> dict[str, Any]:
    """One ``skill_pool`` row as the shape the registry speaks.

    Rows arrive as mappings, not tuples: the pool this store borrows is built
    with ``row_factory=dict_row`` because the checkpointer requires it.
    """
    return {
        "name": row["skill_name"],
        "type": row["type"],
        "category": row["category"],
        "description": row["description"],
        "origin": row["origin"],
        "created_by_agent": row["created_by_agent"],
        "added_at": _utc(row["added_at"]),
    }


def _utc(value: Any) -> datetime:
    """Normalise a DB timestamp to an aware UTC datetime."""
    if not isinstance(value, datetime):
        return _EPOCH
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def catalogue_dir(category: str, skill_name: str) -> Path:
    """On-disk folder of a catalogue skill.

    The catalogue is build-time content seeded from the image, shared by every
    user and never written at runtime, so it stays on the volume — a global pool
    entry points at it rather than copying it.
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
                "SELECT skill_name, type, category, description, origin, "
                "created_by_agent, added_at "
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
                "SELECT skill_name, type, category, description, origin, "
                "created_by_agent, added_at "
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
        global entry's are read from the catalogue on the volume.
        """
        entry = await self.get_pool_entry(user_id, skill_name)
        if entry is None:
            return {}
        if entry["type"] == POOL_TYPE_GLOBAL:
            return _read_catalogue_files(entry["category"], skill_name)

        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT path, content, encoding FROM skill_files "
                "WHERE user_id = %s AND skill_name = %s ORDER BY path",
                (user_id, skill_name),
            )
            rows = await cur.fetchall()
        return {row["path"]: (row["content"], row["encoding"]) for row in rows}

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
    "POOL_TYPE_CUSTOM",
    "POOL_TYPE_GLOBAL",
    "SKILL_ENTRY_FILE",
    "TIER_ASSIGNED",
    "TIER_DECLARED",
    "SkillStore",
    "catalogue_dir",
]
