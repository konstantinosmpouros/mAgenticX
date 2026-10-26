"""User-authored agent definitions, stored in ``agent_runtime``.

A custom agent's definition — its ``AgentSpec``, its ``AGENT.md``, its sub-agent
prompts and any reference material shipped beside them — used to live as a
folder on the agents volume *and* as rows in ``chat_db``, with a 900-second pass
hashing both for every user to keep them agreeing. This is the other half of
what plan 25 did for skills, and it follows the same rule:

    Build-time content lives on the volume. Runtime content lives in the
    database of the service that consumes it.

The agents service reads a definition on **every run** — ``read_prompt``
resolves ``./AGENT.md`` at build time and ``/reference/`` is mounted for the
whole run — so it is the consumer, and it owns the store.

**What does not move.** The ``chat_db.agents`` catalog row stays where it is:
id, slug, name, icon, ``owner_user_id``, ``is_active``. The bridge lists and
routes agents on every page load and conversations carry a foreign key to it, so
that read must not become a cross-service hop. An agent therefore lives in two
places — its *identity* in ``chat_db``, its *definition* here — which is the
deliberate seam of this plan rather than an oversight.

Platform agents are untouched: their folders ship in the image, are identical
for every user and are never written at runtime, so they stay on the volume.

**This is also the ``/reference/`` backend.** ``BaseStore`` over the same rows
lets the mount stay a plain ``StoreBackend`` and inherit its directory
synthesis — ``ls`` splits keys on ``/`` and reports the first segment as a
directory — which is what makes ``subagents/`` show up as a folder to the agent
without any bespoke backend.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

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

logger = get_logger(__name__)

#: The generated manifest. Never stored: it is rendered from the spec on demand,
#: so what runs is always exactly what passed validation — an uploaded or stale
#: copy can never diverge from the spec it claims to describe.
MANIFEST_FILENAME = "agent.yaml"


class AgentDefinitionExistsError(Exception):
    """An insert-only save found the slug already taken by this user."""

_DDL = """
CREATE TABLE IF NOT EXISTS agent_definitions (
    user_id     text NOT NULL,
    agent_slug  text NOT NULL,
    spec        jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, agent_slug)
);

CREATE TABLE IF NOT EXISTS agent_definition_files (
    user_id     text NOT NULL,
    agent_slug  text NOT NULL,
    path        text NOT NULL,
    content     text NOT NULL,
    encoding    text NOT NULL DEFAULT 'utf-8',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, agent_slug, path)
);

-- `agent_runtime` has no alembic chain, so `CREATE TABLE IF NOT EXISTS` is the
-- only schema step — and it does nothing once the table exists. A column added
-- after a deployment has already booted would therefore never appear. These
-- keep the DDL genuinely idempotent: every column the code reads is asserted
-- here, not just in the CREATE above. Add a matching line with every new column.
ALTER TABLE agent_definition_files ADD COLUMN IF NOT EXISTS encoding text NOT NULL DEFAULT 'utf-8';
"""

_COMMENTS = [
    "COMMENT ON TABLE agent_definitions IS "
    "'One row per user-authored agent: the validated AgentSpec as JSON. The "
    "catalog row (id, name, is_active) stays in chat_db.agents.'",
    "COMMENT ON TABLE agent_definition_files IS "
    "'Authored files of a user agent — AGENT.md, subagents/*.md, reference "
    "material. agent.yaml is never stored; it is rendered from the spec.'",
]


class AgentDefinitionStore(BaseStore):
    """The definition tables, and the ``/reference/`` mount over them.

    Namespace is ``(user_id, agent_slug)``. Keys are route-relative absolute
    paths — ``/AGENT.md``, ``/subagents/worker.md``. The leading slash is
    load-bearing: ``StoreBackend.ls`` prefix-matches on it and reports the key
    verbatim as the file path, so a relative key is invisible to ``ls``/``glob``
    even though a direct ``read_file`` would still find it.

    Only :meth:`abatch` is abstract on ``BaseStore`` — ``get``/``search`` are
    defined in terms of it — so the read surface stays small despite backing a
    full file API.
    """

    supports_ttl = False

    def __init__(self, pool: Any) -> None:
        self._pool = pool
        # Captured for the sync `batch` bridge below. Safe to take here: every
        # construction site runs on the service's event loop.
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

    # -- schema -----------------------------------------------------------
    async def setup(self) -> None:
        """Create the tables if absent.

        ``agent_runtime`` has no alembic chain; DDL-on-boot is the convention
        the checkpointer established and agent memory and skills follow. The
        trade is deliberate: no versioned history for these tables.
        """
        async with self._pool.connection() as conn:
            await conn.execute(_DDL)
            for statement in _COMMENTS:
                await conn.execute(statement)

    # -- definition CRUD ---------------------------------------------------
    async def list_specs(self, user_id: str) -> list[dict[str, Any]]:
        """Every agent this user has authored, by slug."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT agent_slug, spec FROM agent_definitions "
                "WHERE user_id = %s ORDER BY agent_slug",
                (user_id,),
            )
            rows = await cur.fetchall()
        return [{"slug": row["agent_slug"], "spec": _spec(row["spec"])} for row in rows]

    async def get_spec(self, user_id: str, agent_slug: str) -> dict[str, Any] | None:
        """One agent's spec, or ``None`` when the user has no such agent."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT spec FROM agent_definitions WHERE user_id = %s AND agent_slug = %s",
                (user_id, agent_slug),
            )
            row = await cur.fetchone()
        return None if row is None else _spec(row["spec"])

    async def get_row(self, user_id: str, agent_slug: str) -> dict[str, Any] | None:
        """The spec plus its ``updated_at``, or ``None``.

        The timestamp is what the per-request definition cache keys on: a save
        moves it, so an edit invalidates the cached agent naturally. That used to
        be the manifest file's mtime, and it is the same property read off a
        different clock — there is no file to stat any more.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT spec, updated_at FROM agent_definitions "
                "WHERE user_id = %s AND agent_slug = %s",
                (user_id, agent_slug),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return {"spec": _spec(row["spec"]), "updated_at": row["updated_at"]}

    async def get_definition(
        self, user_id: str, agent_slug: str
    ) -> tuple[dict[str, Any], dict[str, tuple[str, str]]] | None:
        """Spec **and** files in one call, or ``None``.

        One call on purpose: every read site needs both — the spec to build the
        agent and the files to resolve its prompt — and splitting them would
        make the common path two round trips for data that is always fetched
        together.
        """
        spec = await self.get_spec(user_id, agent_slug)
        if spec is None:
            return None
        return spec, await self.read_files(user_id, agent_slug)

    async def read_files(self, user_id: str, agent_slug: str) -> dict[str, tuple[str, str]]:
        """Authored files as ``{relative path: (content, encoding)}``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT path, content, encoding FROM agent_definition_files "
                "WHERE user_id = %s AND agent_slug = %s ORDER BY path",
                (user_id, agent_slug),
            )
            rows = await cur.fetchall()
        return {row["path"]: (row["content"], row["encoding"]) for row in rows}

    async def save(
        self,
        user_id: str,
        agent_slug: str,
        *,
        spec: dict[str, Any],
        files: dict[str, tuple[str, str]],
        create_only: bool = False,
    ) -> bool:
        """Create or replace one agent's definition. Returns whether it existed.

        Replace, not merge: a save carries the whole definition, so a file the
        user deleted in the builder must not survive as a row the agent goes on
        reading. The spec and its files move in **one transaction** — a spec
        whose ``prompt:`` points at a file that was not written is an agent that
        fails to build, so the two must never land separately.

        ``create_only`` refuses to replace: the insert does nothing on a taken
        slug and :class:`AgentDefinitionExistsError` is raised, so of two
        concurrent creates exactly one wins.
        """
        async with self._pool.connection() as conn, conn.transaction():
            if create_only:
                cur = await conn.execute(
                    "INSERT INTO agent_definitions (user_id, agent_slug, spec) "
                    "VALUES (%s, %s, %s) "
                    "ON CONFLICT (user_id, agent_slug) DO NOTHING "
                    "RETURNING agent_slug",
                    (user_id, agent_slug, json.dumps(spec)),
                )
                if await cur.fetchone() is None:
                    raise AgentDefinitionExistsError(agent_slug)
                replaced = False
            else:
                cur = await conn.execute(
                    "INSERT INTO agent_definitions (user_id, agent_slug, spec) "
                    "VALUES (%s, %s, %s) "
                    "ON CONFLICT (user_id, agent_slug) DO UPDATE SET "
                    "spec = EXCLUDED.spec, updated_at = now() "
                    "RETURNING (xmax <> 0) AS replaced",
                    (user_id, agent_slug, json.dumps(spec)),
                )
                row = await cur.fetchone()
                replaced = bool(row and row.get("replaced"))
            await conn.execute(
                "DELETE FROM agent_definition_files "
                "WHERE user_id = %s AND agent_slug = %s",
                (user_id, agent_slug),
            )
            for path, (content, encoding) in files.items():
                await conn.execute(
                    "INSERT INTO agent_definition_files "
                    "(user_id, agent_slug, path, content, encoding) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (user_id, agent_slug, path, content, encoding),
                )
        return replaced

    async def delete(self, user_id: str, agent_slug: str) -> bool:
        """Remove a definition and its files. Returns whether anything was held.

        Only the *definition* goes. The per-agent state tree — conversations,
        memory rows, tool preferences — is keyed separately and survives, so
        deleting an agent never destroys conversation history.
        """
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "DELETE FROM agent_definitions WHERE user_id = %s AND agent_slug = %s",
                (user_id, agent_slug),
            )
            removed = cur.rowcount > 0
            await conn.execute(
                "DELETE FROM agent_definition_files "
                "WHERE user_id = %s AND agent_slug = %s",
                (user_id, agent_slug),
            )
        return removed

    async def purge_user(self, user_id: str) -> dict[str, int]:
        """Delete every definition and definition file the user holds (plan 32).

        One transaction, so a retry after a failure never meets half a user.
        Idempotent: a second call deletes nothing and reports zeros. A user's
        definitions are a handful of small text rows, so one statement per
        table is bounded in practice.
        """
        async with self._pool.connection() as conn, conn.transaction():
            files = await conn.execute(
                "DELETE FROM agent_definition_files WHERE user_id = %s", (user_id,)
            )
            definitions = await conn.execute(
                "DELETE FROM agent_definitions WHERE user_id = %s", (user_id,)
            )
            return {
                "agent_definitions": definitions.rowcount,
                "agent_definition_files": files.rowcount,
            }

    # -- export (plan 27): pages and slices, never a whole user at once ------
    async def page_definitions(self, user_id: str, after_slug: str, limit: int) -> list[dict[str, Any]]:
        """One page of this user's definitions, keyed after ``after_slug``.

        Keyset paging on the primary key: each page is one short indexed query,
        so an export never holds a connection or a transaction between pages.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT agent_slug, spec, created_at, updated_at FROM agent_definitions "
                "WHERE user_id = %s AND agent_slug > %s ORDER BY agent_slug LIMIT %s",
                (user_id, after_slug, limit),
            )
            rows = await cur.fetchall()
        return [{**row, "spec": _spec(row["spec"])} for row in rows]

    async def page_file_refs(
        self, user_id: str, after: tuple[str, str], limit: int
    ) -> list[dict[str, Any]]:
        """One page of ``(agent_slug, path, encoding)`` — names only, no content.

        Content is read separately in slices (:meth:`read_file_slice`) so a
        large file never sits in memory whole.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT agent_slug, path, encoding FROM agent_definition_files "
                "WHERE user_id = %s AND (agent_slug, path) > (%s, %s) "
                "ORDER BY agent_slug, path LIMIT %s",
                (user_id, after[0], after[1], limit),
            )
            return list(await cur.fetchall())

    async def read_file_slice(
        self, user_id: str, agent_slug: str, path: str, start: int, length: int
    ) -> str:
        """``length`` characters of one file from 1-based ``start``; ``""`` past the end."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT substring(content from %s for %s) AS part FROM agent_definition_files "
                "WHERE user_id = %s AND agent_slug = %s AND path = %s",
                (start, length, user_id, agent_slug, path),
            )
            row = await cur.fetchone()
        return (row["part"] or "") if row else ""

    # -- the one abstract method ------------------------------------------
    async def abatch(self, ops: Iterable[Any]) -> list[Result]:
        results: list[Result] = []
        for op in ops:
            if isinstance(op, GetOp):
                results.append(await self._get(op))
            elif isinstance(op, SearchOp):
                results.append(await self._search(op))
            elif isinstance(op, PutOp):
                # `/reference/` is write-denied by the permission ladder, and
                # deliberately so: a run that could rewrite its own definition
                # could edit its next system prompt. A write reaching here is a
                # dropped rule elsewhere, not a case to support quietly.
                logger.warning(
                    "agent_definition_write_ignored",
                    "Ignored a write to the read-only agent definition mount",
                    key=getattr(op, "key", ""),
                )
                results.append(None)
            elif isinstance(op, ListNamespacesOp):
                results.append([])
            else:
                results.append(None)
        return results

    def batch(self, ops: Iterable[Any]) -> list[Result]:
        """Sync bridge, as the memory and skill stores do it.

        ``BaseStore`` requires both faces. Everything here is async, so the sync
        one hands the work to the loop this store was built on rather than
        opening a second connection path.
        """
        if self._loop is None or not self._loop.is_running():
            return asyncio.run(self.abatch(ops))
        future = asyncio.run_coroutine_threadsafe(self.abatch(list(ops)), self._loop)
        return future.result()

    # -- read helpers ------------------------------------------------------
    async def _files_for(self, namespace: tuple[str, ...]) -> dict[str, tuple[str, str]]:
        """Every file the namespace exposes, keyed by route-relative path."""
        if len(namespace) < 2:
            return {}
        files = await self.read_files(namespace[0], namespace[1])
        return {f"/{path}": payload for path, payload in files.items()}

    async def _get(self, op: GetOp) -> Item | None:
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


def _spec(value: Any) -> dict[str, Any]:
    """A ``spec`` column as a dict.

    psycopg decodes ``jsonb`` for us, but a driver configured otherwise hands
    back the raw text — and a spec that silently reads as a string produces an
    agent that fails validation for no visible reason.
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, (str, bytes)):
        try:
            decoded = json.loads(value)
        except ValueError:
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _as_item(namespace: tuple[str, ...], key: str, content: str, encoding: str) -> Item:
    """Wrap content in the shape ``StoreBackend`` expects to read a file from."""
    now = datetime.now(UTC)
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
    now = datetime.now(UTC)
    return SearchItem(
        namespace=namespace,
        key=key,
        value={"content": content, "encoding": encoding, "modified_at": now.isoformat()},
        created_at=now,
        updated_at=now,
    )


__all__ = [
    "MANIFEST_FILENAME",
    "AgentDefinitionExistsError",
    "AgentDefinitionStore",
]
