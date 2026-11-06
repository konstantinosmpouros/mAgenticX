"""Workflow definitions, versions and persisted state, stored in ``agent_runtime``.

The agents service compiles and runs workflows, so it owns their definitions —
the same rule plan 25 set for skills and agent definitions (runtime content
lives in the database of the service that consumes it). Like those tables,
these are DDL-on-boot: ``agent_runtime`` has no alembic chain, so every column
the code reads is asserted in ``_DDL``.

* ``workflow_definitions`` — one row per workflow: owner, name, the editable
  ``draft`` and the newest version number.
* ``workflow_versions`` — immutable snapshots; a run pins one. A save that
  changes nothing adds no version. History is never rewritten: restoring an
  old version appends a new one with the old spec (``restored_from`` names
  the version it came from).
* ``workflow_persisted_state`` — the ``persist: true`` state fields, carried
  from one completed run to the next.

Every read and write is scoped by ``owner_user_id``: a workflow that is not the
caller's is indistinguishable from one that does not exist (the router's 404).
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from psycopg.types.json import Jsonb

from harness.workflows.spec import canonical_json

MAX_LIST_LIMIT = 100
#: The most versions one history page returns.
MAX_VERSION_PAGE = 100

_DDL = """
CREATE TABLE IF NOT EXISTS workflow_definitions (
    id                 text PRIMARY KEY,
    owner_user_id      text NOT NULL,
    name               text NOT NULL,
    description        text NOT NULL DEFAULT '',
    draft              jsonb NOT NULL,
    latest_version_no  integer NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_definitions_owner_idx
    ON workflow_definitions (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_versions (
    workflow_id  text NOT NULL REFERENCES workflow_definitions (id) ON DELETE CASCADE,
    version_no   integer NOT NULL,
    spec         jsonb NOT NULL,
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    restored_from integer,
    PRIMARY KEY (workflow_id, version_no)
);

CREATE TABLE IF NOT EXISTS workflow_persisted_state (
    workflow_id    text NOT NULL REFERENCES workflow_definitions (id) ON DELETE CASCADE,
    owner_user_id  text NOT NULL,
    field          text NOT NULL,
    value          jsonb NOT NULL,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_id, field)
);
CREATE INDEX IF NOT EXISTS workflow_persisted_state_owner_idx
    ON workflow_persisted_state (owner_user_id);

-- Idempotent column assertions: add a line here with every new column.
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS latest_version_no integer NOT NULL DEFAULT 0;
ALTER TABLE workflow_versions ADD COLUMN IF NOT EXISTS restored_from integer;
"""

_COMMENTS = [
    "COMMENT ON TABLE workflow_definitions IS "
    "'One row per workflow: owner, name and the editable draft WorkflowSpec. "
    "Not an agent and not a conversation.'",
    "COMMENT ON TABLE workflow_versions IS "
    "'Immutable WorkflowSpec snapshots; a run pins one (workflow_id, version_no).'",
    "COMMENT ON TABLE workflow_persisted_state IS "
    "'State fields declared persist: true, carried from one completed run to the next.'",
]

_SUMMARY_COLUMNS = "id, owner_user_id, name, description, latest_version_no, created_at, updated_at"


def _json(value: Any) -> Any:
    """jsonb arrives decoded from psycopg; a text column would not."""
    return json.loads(value) if isinstance(value, (str, bytes)) else value


def _summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "owner_user_id": row["owner_user_id"],
        "name": row["name"],
        "description": row["description"],
        "latest_version_no": row["latest_version_no"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class WorkflowStore:
    """The workflow tables over the shared ``agent_runtime`` pool."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    async def setup(self) -> None:
        """Create the tables if absent (run once from the lifespan)."""
        async with self._pool.connection() as conn:
            await conn.execute(_DDL)
            for statement in _COMMENTS:
                await conn.execute(statement)

    # -- definitions -------------------------------------------------------
    async def list(self, owner_user_id: str, *, limit: int, offset: int) -> list[dict[str, Any]]:
        """One page of the owner's workflows, most recently changed first."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_SUMMARY_COLUMNS} FROM workflow_definitions "
                "WHERE owner_user_id = %s ORDER BY updated_at DESC, id LIMIT %s OFFSET %s",
                (owner_user_id, min(limit, MAX_LIST_LIMIT), offset),
            )
            rows = await cur.fetchall()
        return [_summary(row) for row in rows]

    async def get(self, owner_user_id: str, workflow_id: str) -> dict[str, Any] | None:
        """The definition with its draft and newest version's spec, or ``None``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT d.id, d.owner_user_id, d.name, d.description, d.latest_version_no, "
                "d.created_at, d.updated_at, d.draft, v.spec FROM workflow_definitions d "
                "LEFT JOIN workflow_versions v ON v.workflow_id = d.id AND v.version_no = d.latest_version_no "
                "WHERE d.id = %s AND d.owner_user_id = %s",
                (workflow_id, owner_user_id),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return {**_summary(row), "draft": _json(row["draft"]), "spec": _json(row["spec"])}

    async def create(self, owner_user_id: str, spec: dict[str, Any]) -> str:
        """Store a new workflow: its draft and version 1, in one transaction."""
        workflow_id = str(uuid.uuid4())
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO workflow_definitions (id, owner_user_id, name, description, draft, latest_version_no) "
                "VALUES (%s, %s, %s, %s, %s, 1)",
                (workflow_id, owner_user_id, spec["name"], spec.get("description", ""), Jsonb(spec)),
            )
            await conn.execute(
                "INSERT INTO workflow_versions (workflow_id, version_no, spec, created_by) VALUES (%s, 1, %s, %s)",
                (workflow_id, Jsonb(spec), owner_user_id),
            )
        return workflow_id

    async def update(
        self,
        owner_user_id: str,
        workflow_id: str,
        spec: dict[str, Any],
        *,
        restored_from: int | None = None,
    ) -> int | None:
        """Save the draft; add a version only when the spec changed.

        Returns the newest version number, or ``None`` when the workflow is not
        the owner's. The row is locked for the read-compare-insert, so two
        concurrent saves cannot both claim the next version number.
        ``restored_from`` marks the new version as a restore of that one (a
        restore is a save of an old spec; history is never rewritten).
        """
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "SELECT d.latest_version_no, v.spec FROM workflow_definitions d "
                "LEFT JOIN workflow_versions v ON v.workflow_id = d.id AND v.version_no = d.latest_version_no "
                "WHERE d.id = %s AND d.owner_user_id = %s FOR UPDATE OF d",
                (workflow_id, owner_user_id),
            )
            row = await cur.fetchone()
            if row is None:
                return None
            latest = row["latest_version_no"]
            if row["spec"] is None or canonical_json(_json(row["spec"])) != canonical_json(spec):
                latest += 1
                await conn.execute(
                    "INSERT INTO workflow_versions (workflow_id, version_no, spec, created_by, restored_from) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (workflow_id, latest, Jsonb(spec), owner_user_id, restored_from),
                )
            await conn.execute(
                "UPDATE workflow_definitions SET draft = %s, name = %s, description = %s, "
                "latest_version_no = %s, updated_at = now() WHERE id = %s",
                (Jsonb(spec), spec["name"], spec.get("description", ""), latest, workflow_id),
            )
        return latest

    async def delete(self, owner_user_id: str, workflow_id: str) -> bool:
        """Delete a workflow; versions and persisted state go with it (cascade)."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "DELETE FROM workflow_definitions WHERE id = %s AND owner_user_id = %s",
                (workflow_id, owner_user_id),
            )
        return cur.rowcount > 0

    async def get_version(
        self, owner_user_id: str, workflow_id: str, version_no: int | None
    ) -> tuple[int, dict[str, Any]] | None:
        """``(version_no, spec)`` of a pinned version (``None`` = the newest)."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT v.version_no, v.spec FROM workflow_versions v "
                "JOIN workflow_definitions d ON d.id = v.workflow_id "
                "WHERE d.id = %s AND d.owner_user_id = %s "
                "AND v.version_no = COALESCE(%s, d.latest_version_no)",
                (workflow_id, owner_user_id, version_no),
            )
            row = await cur.fetchone()
        return None if row is None else (row["version_no"], _json(row["spec"]))

    # -- history ---------------------------------------------------------------
    async def list_versions(
        self, owner_user_id: str, workflow_id: str, *, limit: int, before: int | None = None
    ) -> list[dict[str, Any]] | None:
        """One page of the workflow's versions, newest first, without their specs.

        Keyset-paged on ``version_no`` (``before`` = the oldest number already
        shown). Each row carries a short summary read inside the database —
        the version's name and its step / connection counts — so a page never
        moves whole specs. ``None`` when the workflow is not the owner's.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT 1 FROM workflow_definitions WHERE id = %s AND owner_user_id = %s",
                (workflow_id, owner_user_id),
            )
            if await cur.fetchone() is None:
                return None
            cur = await conn.execute(
                "SELECT v.version_no, v.created_at, v.created_by, v.restored_from, "
                "COALESCE(v.spec->>'name', '') AS name, "
                "COALESCE(v.spec->>'description', '') AS description, "
                "CASE WHEN jsonb_typeof(v.spec->'nodes') = 'array' "
                "THEN jsonb_array_length(v.spec->'nodes') ELSE 0 END AS node_count, "
                "CASE WHEN jsonb_typeof(v.spec->'edges') = 'array' "
                "THEN jsonb_array_length(v.spec->'edges') ELSE 0 END AS edge_count "
                "FROM workflow_versions v WHERE v.workflow_id = %s "
                "AND (%s::integer IS NULL OR v.version_no < %s::integer) "
                "ORDER BY v.version_no DESC LIMIT %s",
                (workflow_id, before, before, min(max(limit, 1), MAX_VERSION_PAGE)),
            )
            rows = await cur.fetchall()
        return [dict(row) for row in rows]

    async def get_version_detail(
        self, owner_user_id: str, workflow_id: str, version_no: int
    ) -> dict[str, Any] | None:
        """One kept version with its whole spec, or ``None``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT v.version_no, v.spec, v.created_at, v.created_by, v.restored_from "
                "FROM workflow_versions v JOIN workflow_definitions d ON d.id = v.workflow_id "
                "WHERE d.id = %s AND d.owner_user_id = %s AND v.version_no = %s",
                (workflow_id, owner_user_id, version_no),
            )
            row = await cur.fetchone()
        return None if row is None else {**row, "spec": _json(row["spec"])}

    # -- persisted state ---------------------------------------------------
    async def load_persisted(self, owner_user_id: str, workflow_id: str) -> dict[str, Any]:
        """The ``persist: true`` values the last completed run left."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT field, value FROM workflow_persisted_state WHERE workflow_id = %s AND owner_user_id = %s",
                (workflow_id, owner_user_id),
            )
            rows = await cur.fetchall()
        return {row["field"]: _json(row["value"]) for row in rows}

    async def save_persisted(self, owner_user_id: str, workflow_id: str, values: dict[str, Any]) -> None:
        """Upsert the persisted fields of a completed run, in one transaction."""
        if not values:
            return
        async with self._pool.connection() as conn, conn.transaction():
            for field, value in values.items():
                await conn.execute(
                    "INSERT INTO workflow_persisted_state (workflow_id, owner_user_id, field, value) "
                    "VALUES (%s, %s, %s, %s) ON CONFLICT (workflow_id, field) "
                    "DO UPDATE SET value = EXCLUDED.value, updated_at = now() "
                    "WHERE workflow_persisted_state.owner_user_id = EXCLUDED.owner_user_id",
                    (workflow_id, owner_user_id, field, Jsonb(value)),
                )

    # -- account deletion (plan 32) ------------------------------------------
    async def purge_user(self, user_id: str) -> dict[str, int]:
        """Delete every workflow the user owns, with its versions and state.

        Reported as ``{"workflows", "workflow_versions"}`` — the keys the
        bridge's deletion record reads.
        """
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM workflow_persisted_state WHERE owner_user_id = %s", (user_id,)
            )
            versions = await conn.execute(
                "DELETE FROM workflow_versions WHERE workflow_id IN "
                "(SELECT id FROM workflow_definitions WHERE owner_user_id = %s)",
                (user_id,),
            )
            definitions = await conn.execute(
                "DELETE FROM workflow_definitions WHERE owner_user_id = %s", (user_id,)
            )
            # Persisted state is deleted too; the bridge records these two counts.
            return {"workflows": definitions.rowcount, "workflow_versions": versions.rowcount}

    # -- export (plan 27): keyset pages, never a whole user at once ----------
    async def page_workflows(self, owner_user_id: str, after_id: str, limit: int) -> list[dict[str, Any]]:
        """One page of the owner's workflows (with drafts), keyed after ``after_id``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_SUMMARY_COLUMNS}, draft FROM workflow_definitions "
                "WHERE owner_user_id = %s AND id > %s ORDER BY id LIMIT %s",
                (owner_user_id, after_id, limit),
            )
            rows = await cur.fetchall()
        return [{**_summary(row), "draft": _json(row["draft"])} for row in rows]

    async def page_versions(
        self, owner_user_id: str, after: tuple[str, int], limit: int
    ) -> list[dict[str, Any]]:
        """One page of the owner's workflow versions, keyed after ``(id, version_no)``."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT v.workflow_id, v.version_no, v.spec, v.created_by, v.created_at "
                "FROM workflow_versions v JOIN workflow_definitions d ON d.id = v.workflow_id "
                "WHERE d.owner_user_id = %s AND (v.workflow_id, v.version_no) > (%s, %s) "
                "ORDER BY v.workflow_id, v.version_no LIMIT %s",
                (owner_user_id, after[0], after[1], limit),
            )
            rows = await cur.fetchall()
        return [{**row, "spec": _json(row["spec"])} for row in rows]


__all__ = ["MAX_LIST_LIMIT", "MAX_VERSION_PAGE", "WorkflowStore"]
