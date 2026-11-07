"""``AsyncTaskStore`` against Postgres — the SQL behind the in-memory twin (plan 41 §4).

The runner's rules are pinned in ``test_async_tasks.py`` over ``FakeTaskStore``;
this pins that the real tables behave the same way: idempotent DDL, the
encrypted context and result, updates restricted to whitelisted columns, the
subtree walk, the caps' counts, the outbox query, the startup sweep and the
deletes.

It needs a server: set ``ASYNC_TASKS_TEST_DSN`` (or ``CONVERSATION_FILES_TEST_DSN``)
to a maintenance-database URL, e.g. ``postgresql://admin:admin@localhost:5432/postgres``
for the local compose stack; a scratch database is created and dropped. It is
skipped otherwise.
"""
from __future__ import annotations

import asyncio
import importlib
import os
import sys
import uuid

import pytest
import pytest_asyncio

pytestmark = pytest.mark.asyncio

DSN = os.environ.get("ASYNC_TASKS_TEST_DSN") or os.environ.get("CONVERSATION_FILES_TEST_DSN")


@pytest.fixture(scope="module")
def event_loop_policy():
    """psycopg's async mode cannot run on Windows' default Proactor loop."""
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.DefaultEventLoopPolicy()


@pytest_asyncio.fixture
async def store(agents_service):
    if not DSN:
        pytest.skip("ASYNC_TASKS_TEST_DSN is not set")
    import psycopg
    from psycopg import conninfo, sql
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    database = f"async_tasks_test_{uuid.uuid4().hex[:8]}"
    async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
        await admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    pool = AsyncConnectionPool(conninfo.make_conninfo(DSN, dbname=database), min_size=1, max_size=4, open=False,
                               kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None})
    await pool.open()
    try:
        task_store = importlib.import_module("harness.async_tasks.store").AsyncTaskStore(pool)
        await task_store.setup()
        await task_store.setup()  # idempotent
        yield task_store
    finally:
        await pool.close()
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


def _task(task_id: str, *, parent: str | None = None, depth: int = 1, status: str = "pending") -> dict:
    return {
        "task_id": task_id, "user_id": "u-1", "conversation_id": "c-1", "root_run_id": "m-1",
        "branch_thread_id": "b-1", "parent_task_id": parent, "depth": depth, "agent_slug": "a",
        "definition_version": "v", "subagent_path": "researcher", "interactive": True,
        "context": {"interactive": True, "tool_config": {"approvals": {"x": True}}}, "status": status,
        "name": "researcher",
    }


async def test_tasks_runs_and_the_tree(store):
    await store.insert_task(_task("t1", status="running"))
    await store.insert_task(_task("t2", parent="t1", depth=2, status="running"))
    await store.insert_task(_task("t3", parent="t2", depth=3))
    row = await store.get_task("t1")
    assert row["context"]["tool_config"] == {"approvals": {"x": True}} and row["result"] is None
    assert await store.subtree_ids("t1") == ["t1", "t2", "t3"]
    assert [c["task_id"] for c in await store.children("t1")] == ["t2"]
    assert await store.count_active_for_user("u-1") == 3
    assert await store.count_active_children(parent_task_id=None, conversation_id="c-1", branch_thread_id="b-1") == 1
    assert await store.count_active_children(parent_task_id="t1", conversation_id="c-1", branch_thread_id="b-1") == 1
    assert await store.unsettled_task_ids() == ["t3", "t2", "t1"]

    await store.insert_run({"run_id": "r1", "task_id": "t1", "kind": "start", "status": "running"})
    await store.insert_run({"run_id": "r2", "task_id": "t1", "kind": "update", "status": "pending"})
    await store.update_run("r1", {"usage": {"input_tokens": 5, "calls": 1}, "status": "interrupted"})
    assert [r["run_id"] for r in await store.list_runs("t1", limit=10)] == ["r2", "r1"]
    assert await store.count_runs("t1") == 2
    assert (await store.usage_totals(["t1"]))["t1"] == {"input_tokens": 5, "calls": 1}
    assert await store.fail_unfinished_runs("interrupted by restart") == ["t1"]
    assert (await store.get_run("r2"))["status"] == "error"
    with pytest.raises(ValueError):
        await store.update_task("t1", {"user_id": "u-2"})


async def test_settle_result_and_outbox(store):
    await store.insert_task(_task("t1", status="running"))
    assert await store.mark_notified("t1") is False  # not settled yet
    await store.update_task("t1", {"status": "success", "settled_at": importlib.import_module(
        "harness.async_tasks.store").now(), "result": {"type": "ai", "content": "done"}})
    row = await store.get_task("t1")
    assert row["result"] == {"type": "ai", "content": "done"}
    assert [r["task_id"] for r in await store.unnotified(10)] == ["t1"]
    assert await store.unnotified(10, user_id="u-2") == []
    assert await store.mark_notified("t1") is True
    assert await store.mark_notified("t1") is False
    assert await store.unnotified(10) == []
    assert await store.scope_task_ids("u-1", conversation_id="c-1") == ["t1"]
    assert await store.delete_conversation("u-1", "c-1") == ["t1"]
    assert await store.get_task("t1") is None
