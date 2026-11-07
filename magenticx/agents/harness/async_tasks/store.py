"""Background tasks and their runs, in ``agent_runtime`` (plan 41 §4).

A task is one node of a sub-agent tree, running on its own LangGraph thread
(``task_id`` is that thread id). Its row is the authority for everything about
it: who owns it (user, conversation, the bridge's root run, the branch it was
started from), where it sits in the tree, the context its runs are rebuilt
with, its status, and whether its parent has been told it settled
(``parent_notified_at`` — the durable outbox; Redis is only the doorbell).

``async_task_runs`` holds one row per run: the start, every follow-up, every
approval resume and every internal wake-up.

Same conventions as the other ``agent_runtime`` stores: DDL on boot (there is no
alembic chain here), every column also asserted with ``ADD COLUMN IF NOT
EXISTS``, parameterised SQL only, the shared pool. The run context is
encrypted at rest with the checkpointer's key and cipher, like the checkpoints
themselves (plaintext only when no key is configured — local dev).
"""
from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from typing import Any

from psycopg.types.json import Jsonb

from harness.conversation_files.cipher import get_file_cipher

#: Task statuses (§14.1). The last three are settled.
ACTIVE_STATUSES = ("pending", "running", "waiting_children")
SETTLED_STATUSES = ("success", "error", "cancelled")
TASK_STATUSES = (*ACTIVE_STATUSES, "waiting", *SETTLED_STATUSES)

#: Run statuses, in the Agent Protocol's words. ``interrupted`` is a run that
#: was cancelled or replaced; ``timeout`` one the watchdog stopped.
RUN_FINAL_STATUSES = ("success", "error", "interrupted", "timeout")

_DDL = """
CREATE TABLE IF NOT EXISTS async_tasks (
    task_id             text PRIMARY KEY,
    user_id             text NOT NULL,
    conversation_id     text NOT NULL,
    root_run_id         text NOT NULL,
    branch_thread_id    text NOT NULL,
    parent_task_id      text REFERENCES async_tasks (task_id) ON DELETE CASCADE,
    depth               integer NOT NULL,
    agent_slug          text NOT NULL,
    definition_version  text NOT NULL,
    subagent_path       text NOT NULL,
    interactive         boolean NOT NULL DEFAULT true,
    context             bytea NOT NULL,
    status              text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    settled_at          timestamptz,
    parent_notified_at  timestamptz
);
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS context_cipher text NOT NULL DEFAULT 'none';
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS result_preview text;
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS files_snapshot_hash text;
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS result bytea;
ALTER TABLE async_tasks ADD COLUMN IF NOT EXISTS result_cipher text NOT NULL DEFAULT 'none';
CREATE INDEX IF NOT EXISTS ix_async_tasks_user_status ON async_tasks (user_id, status);
CREATE INDEX IF NOT EXISTS ix_async_tasks_conversation ON async_tasks (conversation_id);
CREATE INDEX IF NOT EXISTS ix_async_tasks_parent ON async_tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS ix_async_tasks_root_run ON async_tasks (root_run_id);
CREATE INDEX IF NOT EXISTS ix_async_tasks_unnotified ON async_tasks (settled_at)
    WHERE parent_notified_at IS NULL AND settled_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS async_task_runs (
    run_id              text PRIMARY KEY,
    task_id             text NOT NULL REFERENCES async_tasks (task_id) ON DELETE CASCADE,
    kind                text NOT NULL,
    multitask_strategy  text,
    status              text NOT NULL,
    error               text,
    usage               jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    started_at          timestamptz,
    ended_at            timestamptz
);
ALTER TABLE async_task_runs ADD COLUMN IF NOT EXISTS waiting boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS ix_async_task_runs_task ON async_task_runs (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_async_task_runs_status ON async_task_runs (status);
"""

_COMMENTS = [
    "COMMENT ON TABLE async_tasks IS 'Background sub-agent tasks (plan 41): one row per node of a "
    "sub-agent tree, on its own LangGraph thread (task_id). context is encrypted with the checkpointer key.'",
    "COMMENT ON TABLE async_task_runs IS 'One row per run of a background task: start, update, resume, wake.'",
]

#: Columns ``update_task`` may set. A whitelist, so a column name never comes
#: from anything but this module.
_TASK_UPDATABLE = frozenset({
    "status", "settled_at", "parent_notified_at", "result_preview", "error",
    "cancel_reason", "files_snapshot_hash", "model", "description", "result",
})
_RUN_UPDATABLE = frozenset({"status", "error", "usage", "started_at", "ended_at", "waiting"})

_TASK_COLUMNS = (
    "task_id, user_id, conversation_id, root_run_id, branch_thread_id, parent_task_id, depth, "
    "agent_slug, definition_version, subagent_path, interactive, context, context_cipher, status, "
    "name, description, model, result_preview, error, cancel_reason, files_snapshot_hash, result, result_cipher, "
    "created_at, updated_at, settled_at, parent_notified_at"
)
_RUN_COLUMNS = (
    "run_id, task_id, kind, multitask_strategy, status, error, usage, waiting, created_at, started_at, ended_at"
)


def now() -> datetime:
    """The clock every timestamp here is written with (UTC, aware)."""
    return datetime.now(UTC)


def _decode_json(row: Mapping[str, Any], column: str) -> dict[str, Any] | None:
    raw = row.get(column)
    if raw is None:
        return None
    data = get_file_cipher().decrypt(str(row.get(f"{column}_cipher") or "none"), bytes(raw))
    value = json.loads(data.decode("utf-8"))
    return value if isinstance(value, dict) else None


def encode_context(context: Mapping[str, Any]) -> tuple[str, bytes]:
    """``(cipher name, stored bytes)`` for a task's run context or result."""
    return get_file_cipher().encrypt(json.dumps(dict(context), separators=(",", ":"), default=str).encode("utf-8"))


def _task(row: Mapping[str, Any]) -> dict[str, Any]:
    task = dict(row)
    task["context"] = _decode_json(row, "context") or {}
    task["result"] = _decode_json(row, "result")
    task.pop("context_cipher", None)
    task.pop("result_cipher", None)
    return task


def _run(row: Mapping[str, Any]) -> dict[str, Any]:
    run = dict(row)
    usage = run.get("usage")
    if isinstance(usage, (str, bytes)):
        usage = json.loads(usage)
    run["usage"] = usage if isinstance(usage, dict) else {}
    return run


class AsyncTaskStore:
    """The two task tables over the shared ``agent_runtime`` pool."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    async def setup(self) -> None:
        """Create the tables if absent (run once from the lifespan)."""
        async with self._pool.connection() as conn:
            await conn.execute(_DDL)
            for statement in _COMMENTS:
                await conn.execute(statement)

    # -- tasks ---------------------------------------------------------------
    async def insert_task(self, task: Mapping[str, Any]) -> None:
        """Store a new task. ``task["context"]`` is a dict; it is encrypted here."""
        cipher, blob = encode_context(task.get("context") or {})
        async with self._pool.connection() as conn:
            await conn.execute(
                "INSERT INTO async_tasks (task_id, user_id, conversation_id, root_run_id, branch_thread_id, "
                "parent_task_id, depth, agent_slug, definition_version, subagent_path, interactive, context, "
                "context_cipher, status, name, description, model) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    task["task_id"], task["user_id"], task["conversation_id"], task["root_run_id"],
                    task["branch_thread_id"], task.get("parent_task_id"), task["depth"], task["agent_slug"],
                    task["definition_version"], task["subagent_path"], bool(task.get("interactive", True)),
                    blob, cipher, task["status"], task.get("name") or "", task.get("description"),
                    task.get("model"),
                ),
            )

    async def get_task(self, task_id: str) -> dict[str, Any] | None:
        async with self._pool.connection() as conn:
            cur = await conn.execute(f"SELECT {_TASK_COLUMNS} FROM async_tasks WHERE task_id = %s", (task_id,))
            row = await cur.fetchone()
        return None if row is None else _task(row)

    async def update_task(self, task_id: str, fields: Mapping[str, Any]) -> None:
        """Set whitelisted columns of one task (and ``updated_at``)."""
        unknown = set(fields) - _TASK_UPDATABLE
        if unknown:
            raise ValueError(f"not updatable: {sorted(unknown)}")
        if not fields:
            return
        values = dict(fields)
        if "result" in values:
            # The final message, encrypted like the context (it is a model's
            # output: the same data as the checkpoints that hold it).
            result = values.pop("result")
            if result is None:
                values["result"], values["result_cipher"] = None, "none"
            else:
                values["result_cipher"], values["result"] = encode_context(result)
        names = sorted(values)
        assignments = ", ".join(f"{name} = %s" for name in names)
        async with self._pool.connection() as conn:
            await conn.execute(
                f"UPDATE async_tasks SET {assignments}, updated_at = now() WHERE task_id = %s",
                (*[values[name] for name in names], task_id),
            )

    async def mark_notified(self, task_id: str, when: datetime | None = None) -> bool:
        """Record that the parent has the settle; True when this call recorded it."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "UPDATE async_tasks SET parent_notified_at = %s, updated_at = now() "
                "WHERE task_id = %s AND parent_notified_at IS NULL AND settled_at IS NOT NULL RETURNING task_id",
                (when or now(), task_id),
            )
            return await cur.fetchone() is not None

    async def clear_notified(self, task_id: str) -> None:
        """Take back a delivery the parent never took in (see ``TaskRunner._reconcile_deliveries``)."""
        async with self._pool.connection() as conn:
            await conn.execute(
                "UPDATE async_tasks SET parent_notified_at = NULL, updated_at = now() WHERE task_id = %s",
                (task_id,),
            )

    async def list_tasks(self, user_id: str, conversation_id: str, limit: int) -> list[dict[str, Any]]:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_TASK_COLUMNS} FROM async_tasks WHERE user_id = %s AND conversation_id = %s "
                "ORDER BY created_at, task_id LIMIT %s",
                (user_id, conversation_id, limit),
            )
            rows = await cur.fetchall()
        return [_task(row) for row in rows]

    async def children(self, task_id: str) -> list[dict[str, Any]]:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_TASK_COLUMNS} FROM async_tasks WHERE parent_task_id = %s ORDER BY created_at, task_id",
                (task_id,),
            )
            rows = await cur.fetchall()
        return [_task(row) for row in rows]

    async def subtree_ids(self, task_id: str) -> list[str]:
        """The task and every descendant, parents before children."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "WITH RECURSIVE tree(task_id, depth) AS ("
                " SELECT task_id, depth FROM async_tasks WHERE task_id = %s"
                " UNION ALL SELECT t.task_id, t.depth FROM async_tasks t JOIN tree ON t.parent_task_id = tree.task_id"
                ") SELECT task_id FROM tree ORDER BY depth, task_id",
                (task_id,),
            )
            rows = await cur.fetchall()
        return [row["task_id"] for row in rows]

    async def count_active_for_user(self, user_id: str) -> int:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT count(*) AS n FROM async_tasks WHERE user_id = %s AND status = ANY(%s)",
                (user_id, list(ACTIVE_STATUSES)),
            )
            row = await cur.fetchone()
        return int(row["n"]) if row else 0

    async def count_active_children(
        self, *, parent_task_id: str | None, conversation_id: str, branch_thread_id: str
    ) -> int:
        """Unsettled children of one parent: a task, or (``parent_task_id`` None)
        the orchestrator on one branch of one conversation."""
        if parent_task_id is not None:
            sql = "SELECT count(*) AS n FROM async_tasks WHERE parent_task_id = %s AND status = ANY(%s)"
            params: tuple[Any, ...] = (parent_task_id, list((*ACTIVE_STATUSES, "waiting")))
        else:
            sql = (
                "SELECT count(*) AS n FROM async_tasks WHERE parent_task_id IS NULL AND conversation_id = %s "
                "AND branch_thread_id = %s AND status = ANY(%s)"
            )
            params = (conversation_id, branch_thread_id, list((*ACTIVE_STATUSES, "waiting")))
        async with self._pool.connection() as conn:
            cur = await conn.execute(sql, params)
            row = await cur.fetchone()
        return int(row["n"]) if row else 0

    async def unnotified(
        self, limit: int, *, user_id: str | None = None, conversation_id: str | None = None
    ) -> list[dict[str, Any]]:
        """Settled depth-1 tasks whose parent (the orchestrator) has not been told."""
        clauses = ["parent_task_id IS NULL", "settled_at IS NOT NULL", "parent_notified_at IS NULL"]
        params: list[Any] = []
        if user_id:
            clauses.append("user_id = %s")
            params.append(user_id)
        if conversation_id:
            clauses.append("conversation_id = %s")
            params.append(conversation_id)
        params.append(limit)
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_TASK_COLUMNS} FROM async_tasks WHERE {' AND '.join(clauses)} "
                "ORDER BY settled_at, task_id LIMIT %s",
                tuple(params),
            )
            rows = await cur.fetchall()
        return [_task(row) for row in rows]

    async def scope_task_ids(
        self, user_id: str, *, conversation_id: str | None = None, root_run_id: str | None = None
    ) -> list[str]:
        """Depth-1 tasks of a user, narrowed to one conversation and/or root run."""
        clauses = ["user_id = %s", "parent_task_id IS NULL"]
        params: list[Any] = [user_id]
        if conversation_id:
            clauses.append("conversation_id = %s")
            params.append(conversation_id)
        if root_run_id:
            clauses.append("root_run_id = %s")
            params.append(root_run_id)
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT task_id FROM async_tasks WHERE {' AND '.join(clauses)} ORDER BY created_at",
                tuple(params),
            )
            rows = await cur.fetchall()
        return [row["task_id"] for row in rows]

    async def unsettled_task_ids(self) -> list[str]:
        """Every task not settled and not waiting, deepest first (startup recovery)."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id FROM async_tasks WHERE status = ANY(%s) ORDER BY depth DESC, created_at",
                (list(ACTIVE_STATUSES),),
            )
            rows = await cur.fetchall()
        return [row["task_id"] for row in rows]

    async def delete_conversation(self, user_id: str, conversation_id: str) -> list[str]:
        """Delete a conversation's tasks (runs cascade); the deleted task ids,
        whose checkpoint threads the caller reaps."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "DELETE FROM async_tasks WHERE user_id = %s AND conversation_id = %s RETURNING task_id",
                (user_id, conversation_id),
            )
            rows = await cur.fetchall()
        return [row["task_id"] for row in rows]

    async def delete_user(self, user_id: str) -> list[str]:
        """Delete every task of a user (account purge); the deleted task ids."""
        async with self._pool.connection() as conn:
            cur = await conn.execute("DELETE FROM async_tasks WHERE user_id = %s RETURNING task_id", (user_id,))
            rows = await cur.fetchall()
        return [row["task_id"] for row in rows]

    # -- runs ----------------------------------------------------------------
    async def insert_run(self, run: Mapping[str, Any]) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                "INSERT INTO async_task_runs (run_id, task_id, kind, multitask_strategy, status) "
                "VALUES (%s, %s, %s, %s, %s)",
                (run["run_id"], run["task_id"], run["kind"], run.get("multitask_strategy"), run["status"]),
            )

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        async with self._pool.connection() as conn:
            cur = await conn.execute(f"SELECT {_RUN_COLUMNS} FROM async_task_runs WHERE run_id = %s", (run_id,))
            row = await cur.fetchone()
        return None if row is None else _run(row)

    async def update_run(self, run_id: str, fields: Mapping[str, Any]) -> None:
        unknown = set(fields) - _RUN_UPDATABLE
        if unknown:
            raise ValueError(f"not updatable: {sorted(unknown)}")
        if not fields:
            return
        names = sorted(fields)
        values = [Jsonb(fields[n]) if n == "usage" else fields[n] for n in names]
        assignments = ", ".join(f"{name} = %s" for name in names)
        async with self._pool.connection() as conn:
            await conn.execute(f"UPDATE async_task_runs SET {assignments} WHERE run_id = %s", (*values, run_id))

    async def list_runs(self, task_id: str, *, limit: int, offset: int = 0) -> list[dict[str, Any]]:
        """Runs of one task, newest first."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_RUN_COLUMNS} FROM async_task_runs WHERE task_id = %s "
                "ORDER BY created_at DESC, run_id DESC LIMIT %s OFFSET %s",
                (task_id, limit, offset),
            )
            rows = await cur.fetchall()
        return [_run(row) for row in rows]

    async def count_runs(self, task_id: str) -> int:
        async with self._pool.connection() as conn:
            cur = await conn.execute("SELECT count(*) AS n FROM async_task_runs WHERE task_id = %s", (task_id,))
            row = await cur.fetchone()
        return int(row["n"]) if row else 0

    async def usage_totals(self, task_ids: Iterable[str]) -> dict[str, dict[str, int]]:
        """Summed run usage per task."""
        ids = list(task_ids)
        if not ids:
            return {}
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT task_id, usage FROM async_task_runs WHERE task_id = ANY(%s)", (ids,)
            )
            rows = await cur.fetchall()
        totals: dict[str, dict[str, int]] = {}
        for row in rows:
            usage = _run(row)["usage"]
            bucket = totals.setdefault(row["task_id"], {})
            for key, value in usage.items():
                if isinstance(value, int):
                    bucket[key] = bucket.get(key, 0) + value
        return totals

    async def fail_unfinished_runs(self, error: str) -> list[str]:
        """Mark every pending or running run as errored; the tasks they belonged to.

        Startup recovery (§3.8): this process holds no run, so any run the table
        calls active was cut by a restart.
        """
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "UPDATE async_task_runs SET status = 'error', error = %s, ended_at = now() "
                "WHERE status IN ('pending', 'running') RETURNING task_id",
                (error,),
            )
            rows = await cur.fetchall()
        return sorted({row["task_id"] for row in rows})


__all__ = [
    "ACTIVE_STATUSES",
    "RUN_FINAL_STATUSES",
    "SETTLED_STATUSES",
    "TASK_STATUSES",
    "AsyncTaskStore",
    "encode_context",
    "now",
]
