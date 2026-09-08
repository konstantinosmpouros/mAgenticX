"""Agent memory, stored in ``agent_runtime`` — no filesystem underneath.

Memory used to live only on the agents-service volume, which has no backup:
losing it destroyed everything every agent had learned about every user. It now
lives in a table, and the ``/memories/`` mount is a *virtual* route over that
table rather than a directory.

That is the whole point of implementing :class:`~langgraph.store.base.BaseStore`
here instead of using LangGraph's own ``AsyncPostgresStore``. The generic store
is one `(prefix, key, value jsonb)` table, which would have made provenance —
``source_run_id``, ``created_by``, ``trust_level`` — unindexed JSON. Memory is a
*persistent injection surface*: a durable entry is effectively future context, so
an entry written after the agent read a poisoned web page needs to be findable
and enforceable by query, not by scanning JSON.

Two representations, one write:

* ``raw`` is the yml the agent reads back, byte for byte.
* the columns are the queryable projection of it.

Both are written from the same record in the same statement, so they cannot
drift. Reads return ``raw`` verbatim — there is no render step, so no round-trip
fidelity to lose.

``AGENTS.md`` is **derived**, not stored. It is the always-on index the model
sees, and it is exactly ``AGENTS_MD_TEMPLATE`` plus one :func:`index_line` per
row — so synthesising it on read deletes the drift class where the index and the
entries disagree. It also means a ``write_file`` to it is a no-op: the index
cannot be edited out of step with the entries it indexes.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

import yaml
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
from harness.memory.index import MEMORIES_HEADER, index_line
from harness.memory.template import AGENTS_MD_TEMPLATE

logger = get_logger(__name__)

# The key the derived index answers to, and the prefix every real entry uses.
# These are the file paths the agent knows, with the `/memories/` route already
# stripped — so they are absolute, and the leading slash is load-bearing:
# StoreBackend.ls() prefix-matches on it and reports `item.key` verbatim as the
# file path, so a relative key would make the file invisible to `ls`/`glob`.
INDEX_KEY = "/AGENTS.md"
ENTRY_PREFIX = "/entries/"
ENTRY_SUFFIX = ".yml"

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

_DDL = """
CREATE TABLE IF NOT EXISTS agent_memories (
    user_id     text NOT NULL,
    agent_slug  text NOT NULL,
    name        text NOT NULL,
    raw         text NOT NULL,
    summary     text NOT NULL DEFAULT '',
    content     text NOT NULL DEFAULT '',
    source_conversation_id text,
    source_run_id          text,
    source_thread_id       text,
    created_by  text NOT NULL DEFAULT 'agent',
    trust_level text NOT NULL DEFAULT 'unknown',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, agent_slug, name)
);
"""

# Provenance is only knowable at write time and cannot be backfilled, which is
# why it is in the first version of this table rather than added later.
_COMMENTS = [
    "COMMENT ON COLUMN agent_memories.raw IS "
    "'The yml the agent reads back, verbatim. Canonical; the other columns are its projection.'",
    "COMMENT ON COLUMN agent_memories.trust_level IS "
    "'Approximation, not a guarantee: set per RUN from whether the run had any external-content "
    "tool attached, not per turn. Treat as a review signal, never as authorization.'",
]


def normalise_key(key: str) -> str:
    """Absolute form of a mount-relative key.

    The composite backend hands us route-stripped absolute paths, but nothing
    guarantees every caller does; normalising here means one canonical shape
    reaches the table.
    """
    return key if key.startswith("/") else "/" + key


def entry_key(name: str) -> str:
    """The mount path an entry answers to."""
    return f"{ENTRY_PREFIX}{name}{ENTRY_SUFFIX}"


def entry_name(key: str) -> Optional[str]:
    """The entry name behind a mount path, or None if the key is not an entry."""
    key = normalise_key(key)
    if not key.startswith(ENTRY_PREFIX) or not key.endswith(ENTRY_SUFFIX):
        return None
    name = key[len(ENTRY_PREFIX) : -len(ENTRY_SUFFIX)]
    return name or None


def render_entry(record: dict[str, Any]) -> str:
    """The yml body for a memory record — the bytes the agent reads.

    Field order is fixed so a re-save of unchanged content produces identical
    bytes; a store that shuffled keys would make every write look like a change.
    Provenance is deliberately absent: it lives in columns only, so the agent
    cannot rewrite its own audit trail through the filesystem tools.
    """
    return yaml.safe_dump(
        {
            "name": record["name"],
            "summary": record.get("summary") or "",
            "content": record.get("content") or "",
            "created_at": record.get("created_at"),
            "updated_at": record.get("updated_at"),
            "source_conversation_id": record.get("source_conversation_id"),
        },
        sort_keys=False,
        allow_unicode=True,
    )


def parse_entry(raw: str) -> dict[str, Any]:
    """Best-effort projection of yml back into columns.

    Only reached when something writes an entry through the *filesystem* tools
    rather than the ``remember`` tool — the mount is read-write, so the agent
    can. Unparseable content is still stored verbatim in ``raw``; only the
    projection degrades, because the agent's read path must never depend on us
    understanding what it wrote.
    """
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


class AgentMemoryStore(BaseStore):
    """``BaseStore`` over ``agent_memories``, scoped by ``(user_id, agent_slug)``.

    Only :meth:`abatch` is abstract on ``BaseStore`` — ``get``/``put``/``search``
    and friends are all defined in terms of it — so this is a small surface
    despite backing a full file API.

    Namespaces are ``(user_id, agent_slug)``. Memory is per-pair on purpose: one
    agent's accumulated memory must never reach another's context, and the
    namespace is what enforces it.
    """

    supports_ttl = False

    def __init__(self, pool: Any) -> None:
        self._pool = pool
        # Captured for the sync `batch` bridge below. Safe to take here: every
        # construction site (the mount factory, the inspector routes) runs on
        # the service's event loop.
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

    # -- setup ------------------------------------------------------------
    async def setup(self) -> None:
        """Create the table if absent. ``agent_runtime`` has no alembic chain;
        DDL-on-boot is the convention the checkpointer already established."""
        async with self._pool.connection() as conn:
            await conn.execute(_DDL)
            for statement in _COMMENTS:
                await conn.execute(statement)

    # -- the one abstract method -----------------------------------------
    async def abatch(self, ops: Iterable[Any]) -> list[Result]:
        results: list[Result] = []
        for op in ops:
            if isinstance(op, GetOp):
                results.append(await self._get(op))
            elif isinstance(op, PutOp):
                results.append(await self._put(op))
            elif isinstance(op, SearchOp):
                results.append(await self._search(op))
            elif isinstance(op, ListNamespacesOp):
                results.append(await self._list_namespaces(op))
            else:
                raise NotImplementedError(
                    f"AgentMemoryStore does not implement {type(op).__name__}"
                )
        return results

    def batch(self, ops: Iterable[Any]) -> list[Result]:
        """Sync entry point, bridged onto the running loop.

        Needed despite this service being async throughout: deepagents'
        ``StoreBackend.ls()`` is synchronous, and the protocol layer runs it via
        ``asyncio.to_thread`` — so ``ls``/``glob``/``grep`` over ``/memories/``
        arrive here on a worker thread, not through :meth:`abatch`. Raising
        would leave the agent able to read its memory but not list it.

        The bridge is what avoids a second, synchronous pool. It is only safe
        from a worker thread: the loop is idle there (it is awaiting the
        ``to_thread`` future), so blocking on it cannot deadlock. Called *on*
        the loop thread it would deadlock, so that case is refused — and it is a
        programming error anyway, since ``abatch`` is right there.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise RuntimeError(
                "AgentMemoryStore.batch() called from the event loop thread; "
                "use abatch() instead."
            )
        if self._loop is None or not self._loop.is_running():
            raise RuntimeError(
                "AgentMemoryStore.batch() needs the service event loop; none is running."
            )
        return asyncio.run_coroutine_threadsafe(self.abatch(ops), self._loop).result()

    # -- ops --------------------------------------------------------------
    async def _get(self, op: GetOp) -> Optional[Item]:
        user_id, agent_slug = _split(op.namespace)
        key = normalise_key(op.key)
        if key == INDEX_KEY:
            return await self._index_item(user_id, agent_slug, op.namespace)
        name = entry_name(key)
        if name is None:
            return None
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT raw, created_at, updated_at FROM agent_memories "
                "WHERE user_id = %s AND agent_slug = %s AND name = %s",
                (user_id, agent_slug, name),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return _file_item(op.namespace, key, row["raw"], row["created_at"], row["updated_at"])

    async def _put(self, op: PutOp) -> None:
        user_id, agent_slug = _split(op.namespace)
        key = normalise_key(op.key)
        name = entry_name(key)

        if op.value is None:
            if name is not None:
                await self.delete_entry(user_id, agent_slug, name)
            return None

        if key == INDEX_KEY:
            # Derived from the rows, so there is nothing to store and nothing to
            # honour. Silently accepting keeps `write_file` from erroring mid-run
            # over a write whose effect is already guaranteed by the entries.
            logger.info(
                "agent_memory_index_write_ignored",
                "Ignored a write to the derived memory index",
                user_id=user_id,
                agent_slug=agent_slug,
            )
            return None

        if name is None:
            # A path under /memories/ that is neither the index nor an entry.
            # Refusing beats inventing a row shape for it.
            logger.warning(
                "agent_memory_unsupported_key",
                "Refused a write to an unsupported memory path",
                user_id=user_id,
                agent_slug=agent_slug,
                memory_key=key,
            )
            return None

        raw = op.value.get("content") or ""
        if isinstance(raw, list):
            # deepagents' legacy `file_format="v1"` stores content as lines.
            raw = "\n".join(str(part) for part in raw)
        fields = parse_entry(raw)
        await self.upsert(
            user_id=user_id,
            agent_slug=agent_slug,
            name=name,
            raw=raw,
            summary=str(fields.get("summary") or ""),
            content=str(fields.get("content") or ""),
            source_conversation_id=fields.get("source_conversation_id"),
            created_by="agent",
        )
        return None

    async def _search(self, op: SearchOp) -> list[SearchItem]:
        user_id, agent_slug = _split(op.namespace_prefix)
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT name, raw, created_at, updated_at FROM agent_memories "
                "WHERE user_id = %s AND agent_slug = %s ORDER BY name",
                (user_id, agent_slug),
            )
            rows = await cur.fetchall()

        items = [
            SearchItem(
                namespace=tuple(op.namespace_prefix),
                key=entry_key(row["name"]),
                value=_file_value(row["raw"], row["created_at"], row["updated_at"]),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
            for row in rows
        ]
        # The index is not a row, but `ls` / `glob` / `grep` over /memories/ go
        # through search — omitting it would make AGENTS.md invisible to the
        # very tools the agent uses to discover its own memory.
        index = await self._index_item(user_id, agent_slug, tuple(op.namespace_prefix))
        if index is not None:
            items.insert(
                0,
                SearchItem(
                    namespace=index.namespace,
                    key=index.key,
                    value=index.value,
                    created_at=index.created_at,
                    updated_at=index.updated_at,
                ),
            )
        offset = op.offset or 0
        limit = op.limit if op.limit is not None else len(items)
        return items[offset : offset + limit]

    async def _list_namespaces(self, op: ListNamespacesOp) -> list[tuple[str, ...]]:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT DISTINCT user_id, agent_slug FROM agent_memories "
                "ORDER BY user_id, agent_slug"
            )
            rows = await cur.fetchall()
        return [(row["user_id"], row["agent_slug"]) for row in rows]

    # -- the derived index ------------------------------------------------
    async def _index_item(
        self, user_id: str, agent_slug: str, namespace: tuple[str, ...]
    ) -> Optional[Item]:
        rows = await self.list_pair(user_id, agent_slug)
        text = build_index(rows)
        newest = max((r["updated_at"] for r in rows), default=_EPOCH)
        return _file_item(namespace, INDEX_KEY, text, newest, newest)

    # -- typed API (the tool and the inspector use this, not the file API) --
    async def upsert(
        self,
        *,
        user_id: str,
        agent_slug: str,
        name: str,
        summary: str = "",
        content: str = "",
        raw: Optional[str] = None,
        source_conversation_id: Optional[str] = None,
        source_run_id: Optional[str] = None,
        source_thread_id: Optional[str] = None,
        created_by: str = "agent",
        trust_level: str = "unknown",
    ) -> dict[str, Any]:
        """Write one memory. Idempotent by ``(user, agent, name)``.

        Idempotency is the point, not a nicety: LangGraph checkpoints at
        super-step boundaries, so a node that is re-entered after an approval
        pause, a tool retry or a restart re-runs this. Keying on the name and
        preserving ``created_at`` makes a second write produce the same row.

        ``raw`` is rendered from the record when the caller does not supply it,
        which is the normal path — the ``remember`` tool passes fields, not yml.
        """
        now = datetime.now(timezone.utc).isoformat()
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT created_at FROM agent_memories "
                "WHERE user_id = %s AND agent_slug = %s AND name = %s",
                (user_id, agent_slug, name),
            )
            prior = await cur.fetchone()
            created_at = (
                prior["created_at"].isoformat() if prior else now
            )
            body = raw if raw is not None else render_entry(
                {
                    "name": name,
                    "summary": summary,
                    "content": content,
                    "created_at": created_at,
                    "updated_at": now,
                    "source_conversation_id": source_conversation_id,
                }
            )
            await conn.execute(
                """
                INSERT INTO agent_memories (
                    user_id, agent_slug, name, raw, summary, content,
                    source_conversation_id, source_run_id, source_thread_id,
                    created_by, trust_level, updated_at
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
                ON CONFLICT (user_id, agent_slug, name) DO UPDATE SET
                    raw = EXCLUDED.raw,
                    summary = EXCLUDED.summary,
                    content = EXCLUDED.content,
                    source_conversation_id = EXCLUDED.source_conversation_id,
                    source_run_id = EXCLUDED.source_run_id,
                    source_thread_id = EXCLUDED.source_thread_id,
                    trust_level = EXCLUDED.trust_level,
                    updated_at = now()
                """,
                (
                    user_id, agent_slug, name, body, summary, content,
                    source_conversation_id, source_run_id, source_thread_id,
                    created_by, trust_level,
                ),
            )
        return {"name": name, "summary": summary, "raw": body}

    async def list_pair(self, user_id: str, agent_slug: str) -> list[dict[str, Any]]:
        """Every memory for a (user, agent), sorted by name. Includes ``raw``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT name, summary, content, raw, source_conversation_id,
                       source_run_id, source_thread_id, created_by, trust_level,
                       created_at, updated_at
                FROM agent_memories
                WHERE user_id = %s AND agent_slug = %s
                ORDER BY name
                """,
                (user_id, agent_slug),
            )
            return list(await cur.fetchall())

    async def read_entry(
        self, user_id: str, agent_slug: str, name: str
    ) -> Optional[dict[str, Any]]:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                """
                SELECT name, summary, content, raw, source_conversation_id,
                       source_run_id, source_thread_id, created_by, trust_level,
                       created_at, updated_at
                FROM agent_memories
                WHERE user_id = %s AND agent_slug = %s AND name = %s
                """,
                (user_id, agent_slug, name),
            )
            return await cur.fetchone()

    async def delete_entry(self, user_id: str, agent_slug: str, name: str) -> bool:
        """Remove one memory. Idempotent; no tombstone needed.

        A tombstone existed in the two-store design to tell "the other copy lost
        it" apart from "the user deleted it". With one copy there is no other
        side to reconcile against, so a delete is just a delete.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "DELETE FROM agent_memories "
                "WHERE user_id = %s AND agent_slug = %s AND name = %s",
                (user_id, agent_slug, name),
            )
            removed = cur.rowcount > 0
        if removed:
            logger.info(
                "agent_memory_deleted",
                "Deleted an agent memory entry",
                user_id=user_id,
                agent_slug=agent_slug,
                memory_name=name,
            )
        return removed

    async def count_pair(self, user_id: str, agent_slug: str) -> int:
        """Row count for the ``MEMORY_MAX_ENTRIES`` cap the tool enforces."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT count(*) AS n FROM agent_memories "
                "WHERE user_id = %s AND agent_slug = %s",
                (user_id, agent_slug),
            )
            row = await cur.fetchone()
        return int(row["n"]) if row else 0

    async def pairs_with_memory(self) -> list[tuple[str, str]]:
        return [tuple(ns) for ns in await self._list_namespaces(ListNamespacesOp(()))]  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def build_index(rows: list[dict[str, Any]]) -> str:
    """``AGENTS.md`` from rows: the template plus one index line each.

    Reuses :func:`index_line` rather than re-deriving the row format. That
    function is the single authority for it — a second implementation here would
    drift from the one the delete path matches against.
    """
    lines = AGENTS_MD_TEMPLATE.rstrip("\n").splitlines()
    out: list[str] = []
    inserted = False
    for line in lines:
        out.append(line)
        if not inserted and line.strip().lower() == MEMORIES_HEADER.lower():
            out.extend(index_line(r["name"], r.get("summary") or "") for r in rows)
            inserted = True
    if not inserted:
        out.extend(["", MEMORIES_HEADER])
        out.extend(index_line(r["name"], r.get("summary") or "") for r in rows)
    return "\n".join(out) + "\n"


def _split(namespace: Iterable[str]) -> tuple[str, str]:
    parts = tuple(namespace)
    if len(parts) < 2:
        raise ValueError(
            f"Agent memory namespace must be (user_id, agent_slug); got {parts!r}"
        )
    return parts[0], parts[1]


def _file_value(raw: str, created: datetime, updated: datetime) -> dict[str, Any]:
    """The shape deepagents' StoreBackend expects a stored file to have."""
    return {
        "content": raw,
        "encoding": "utf-8",
        "created_at": created.isoformat(),
        "modified_at": updated.isoformat(),
    }


def _file_item(
    namespace: tuple[str, ...], key: str, raw: str, created: datetime, updated: datetime
) -> Item:
    return Item(
        value=_file_value(raw, created, updated),
        key=key,
        namespace=tuple(namespace),
        created_at=created,
        updated_at=updated,
    )


__all__ = [
    "AgentMemoryStore",
    "INDEX_KEY",
    "build_index",
    "entry_key",
    "entry_name",
    "normalise_key",
    "parse_entry",
    "render_entry",
]
