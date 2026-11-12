"""``ConversationSourceStore`` — a conversation's sources as rows (plan 42 §3.7).

Pinned:

* the payload is encrypted with the conversation files' cipher and reads back
  as the same ``Source``;
* an upsert keeps one row per id and refreshes it; a list is newest first,
  capped, and skips a row that no longer validates;
* a fork copy, a conversation delete and an account purge each touch only
  their own scope.

The Postgres half needs a server: set ``CONVERSATION_FILES_TEST_DSN`` (the same
variable the conversation-file store tests use) to a maintenance-database URL,
e.g. ``postgresql://admin:admin@localhost:5432/postgres``; a scratch database is
created and dropped. It is skipped otherwise.
"""
from __future__ import annotations

import asyncio
import importlib
import os
import sys
import uuid

import psycopg
import pytest
import pytest_asyncio
from langgraph.checkpoint.serde.encrypted import EncryptedSerializer
from psycopg import conninfo, sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

pytestmark = pytest.mark.asyncio

DSN = os.environ.get("CONVERSATION_FILES_TEST_DSN")
KEY = b"0123456789abcdef0123456789abcdef"


@pytest.fixture(scope="module")
def event_loop_policy():
    """psycopg's async mode cannot run on Windows' default Proactor loop."""
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.DefaultEventLoopPolicy()


@pytest.fixture
def sources(agents_service):
    return importlib.import_module("harness.sources")


def _cipher(key: bytes | None):
    module = importlib.import_module("harness.conversation_files.cipher")
    if key is None:
        return module.FileCipher(None)
    return module.FileCipher(EncryptedSerializer.from_pycryptodome_aes(key=key).cipher)


def _source(sources, n: int, **extra):
    url = f"https://example.com/{n}"
    return sources.Source(id=sources.source_id(url), url=url, title=f"Page {n}", snippet="s", tool="tavily-search",
                          **extra)


# ---------------------------------------------------------- a recording pool
class _Cursor:
    def __init__(self, owner, rows=None, rowcount=2):
        self._owner = owner
        self._rows = rows or []
        self.rowcount = rowcount

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def fetchall(self):
        return self._rows

    async def executemany(self, statement, params):
        self._owner.many.append((" ".join(statement.split()), list(params)))


class _Conn:
    def __init__(self, owner):
        self._owner = owner

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def transaction(self):
        return self

    def cursor(self):
        return _Cursor(self._owner)

    async def execute(self, statement, params=None):
        self._owner.calls.append((" ".join(statement.split()), params))
        return _Cursor(self._owner, rows=self._owner.rows)


class _Pool:
    def __init__(self, rows=None):
        self.calls: list = []
        self.many: list = []
        self.rows = rows or []

    def connection(self):
        return _Conn(self)


async def test_an_upsert_seals_each_source_once(sources):
    pool = _Pool()
    store = sources.ConversationSourceStore(pool, _cipher(KEY))
    a, b = _source(sources, 1), _source(sources, 2)

    assert await store.upsert_many("u1", "c1", [a, b, a]) == 2

    [(statement, params)] = pool.many
    assert statement.startswith("INSERT INTO conversation_sources") and "ON CONFLICT" in statement
    assert [p["source_id"] for p in params] == [a.id, b.id]
    assert all(p["user_id"] == "u1" and p["conversation_id"] == "c1" and p["cipher"] == "aes" for p in params)
    assert b"example.com" not in params[0]["payload"]  # encrypted at rest
    assert await store.upsert_many("u1", "c1", []) == 0 and len(pool.many) == 1


async def test_a_list_opens_each_row_and_skips_one_that_no_longer_validates(sources):
    cipher = _cipher(KEY)
    good = _source(sources, 1)
    name, sealed = cipher.encrypt(b'{"url": "https://example.com/1", "title": "Page 1", "snippet": "s", "tool": "t"}')
    bad_name, bad = cipher.encrypt(b'{"url": "javascript:alert(1)", "title": "x", "snippet": "", "tool": "t"}')
    pool = _Pool(rows=[
        {"source_id": good.id, "cipher": name, "payload": sealed},
        {"source_id": "abcdef", "cipher": bad_name, "payload": bad},
    ])

    listed = await sources.ConversationSourceStore(pool, cipher).list_sources("u1", "c1", limit=10_000)

    assert [(s.id, s.url, s.title) for s in listed] == [(good.id, good.url, "Page 1")]
    [(statement, params)] = pool.calls
    assert "ORDER BY updated_at DESC" in statement
    assert params == {"user_id": "u1", "conversation_id": "c1", "limit": 500}


async def test_copy_delete_and_purge_are_scoped(sources):
    pool = _Pool()
    store = sources.ConversationSourceStore(pool, _cipher(None))

    assert await store.copy_conversation("u1", "c1", "fork") == 2
    assert await store.delete_conversation("u1", "c1") == 2
    assert await store.purge_user("u1") == {"conversation_sources": 2}

    copy, delete, purge = pool.calls
    assert copy[1] == {"user_id": "u1", "source": "c1", "target": "fork"} and "DO NOTHING" in copy[0]
    assert delete == ("DELETE FROM conversation_sources WHERE user_id = %(user_id)s "
                      "AND conversation_id = %(conversation_id)s", {"user_id": "u1", "conversation_id": "c1"})
    assert purge == ("DELETE FROM conversation_sources WHERE user_id = %s", ("u1",))


# ---------------------------------------------------------------- Postgres
@pytest_asyncio.fixture
async def pg_pool(agents_service):
    if not DSN:
        pytest.skip("CONVERSATION_FILES_TEST_DSN is not set")
    database = f"conversation_sources_test_{uuid.uuid4().hex[:8]}"
    async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
        await admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    target = conninfo.make_conninfo(DSN, dbname=database)
    pool = AsyncConnectionPool(target, min_size=1, max_size=4, open=False,
                               kwargs={"autocommit": True, "row_factory": dict_row, "prepare_threshold": None})
    await pool.open()
    try:
        yield pool
    finally:
        await pool.close()
        async with await psycopg.AsyncConnection.connect(DSN, autocommit=True) as admin:
            await admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


@pytest_asyncio.fixture
async def pg_store(pg_pool, sources):
    store = sources.ConversationSourceStore(pg_pool, _cipher(KEY))
    await store.setup()
    await store.setup()  # idempotent: every boot runs it
    return store


async def test_sources_round_trip_newest_first_and_upsert_keeps_one_row(pg_store, pg_pool, sources):
    first, second = _source(sources, 1), _source(sources, 2)
    await pg_store.upsert_many("u1", "c1", [first])
    await pg_store.upsert_many("u1", "c1", [second])
    await pg_store.upsert_many("u1", "c1", [first.model_copy(update={"title": "Page 1, again"})])

    listed = await pg_store.list_sources("u1", "c1")

    assert [(s.id, s.title) for s in listed] == [(first.id, "Page 1, again"), (second.id, "Page 2")]
    async with pg_pool.connection() as conn:
        cur = await conn.execute("SELECT payload FROM conversation_sources")
        assert all(b"example.com" not in bytes(row["payload"]) for row in await cur.fetchall())


async def test_fork_delete_and_purge_touch_only_their_scope(pg_store, sources):
    await pg_store.upsert_many("u1", "c1", [_source(sources, 1), _source(sources, 2)])
    await pg_store.upsert_many("u2", "c1", [_source(sources, 3)])

    assert await pg_store.copy_conversation("u1", "c1", "fork") == 2
    assert await pg_store.copy_conversation("u1", "c1", "fork") == 0  # a retry changes nothing
    assert await pg_store.delete_conversation("u1", "c1") == 2
    assert len(await pg_store.list_sources("u1", "fork")) == 2
    assert len(await pg_store.list_sources("u2", "c1")) == 1
    assert await pg_store.purge_user("u1") == {"conversation_sources": 2}
    assert len(await pg_store.list_sources("u2", "c1")) == 1


async def test_the_table_refuses_an_id_outside_the_contract(pg_pool, pg_store):
    with pytest.raises(psycopg.errors.CheckViolation):
        async with pg_pool.connection() as conn:
            await conn.execute(
                "INSERT INTO conversation_sources (user_id, conversation_id, source_id, cipher, payload) "
                "VALUES ('u1', 'c1', 'XYZ', 'none', '\\x00')"
            )
