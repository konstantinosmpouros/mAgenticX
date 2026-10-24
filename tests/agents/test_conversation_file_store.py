"""``ConversationFileStore`` — a conversation's files as rows (plan 43).

Pinned here:

* the **contract** the backend relies on — write-once ``create``, ``replace``,
  a locked ``edit``, prefix listing without bytes, file/directory conflicts —
  run against the in-memory store the other tests use *and* against Postgres,
  so the two cannot drift;
* **encryption at rest** with the checkpointer's key and cipher;
* **forks copy no bytes**: a fork adds path rows naming the same blobs;
* **blob garbage collection**: a blob goes with the last row that names it,
  never before;
* deletion by conversation and by user.

The Postgres half needs a server: set ``CONVERSATION_FILES_TEST_DSN`` to a
maintenance-database URL (e.g. ``postgresql://admin:admin@localhost:5432/postgres``
for the local compose stack); a scratch database is created and dropped. It is
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

DSN = os.environ.get("CONVERSATION_FILES_TEST_DSN")
KEY = b"0123456789abcdef0123456789abcdef"


def _cipher(key: bytes | None):
    module = importlib.import_module("harness.conversation_files.cipher")
    if key is None:
        return module.FileCipher(None)
    from langgraph.checkpoint.serde.encrypted import EncryptedSerializer

    return module.FileCipher(EncryptedSerializer.from_pycryptodome_aes(key=key).cipher)


@pytest.fixture(scope="module")
def event_loop_policy():
    """psycopg's async mode cannot run on Windows' default Proactor loop."""
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.DefaultEventLoopPolicy()


@pytest_asyncio.fixture
async def pg_pool(agents_service):
    if not DSN:
        pytest.skip("CONVERSATION_FILES_TEST_DSN is not set")
    import psycopg
    from psycopg import conninfo, sql
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    database = f"conversation_files_test_{uuid.uuid4().hex[:8]}"
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
async def pg_store(pg_pool):
    store = importlib.import_module("harness.conversation_files.store").ConversationFileStore(pg_pool, _cipher(KEY))
    await store.setup()
    await store.setup()  # idempotent: every boot runs it
    return store


@pytest.fixture(params=["memory", "postgres"])
def store(request, memory_file_store):
    if request.param == "memory":
        return memory_file_store
    return request.getfixturevalue("pg_store")


async def _count(pool, table: str, where: str = "TRUE", params: tuple = ()) -> int:
    async with pool.connection() as conn:
        cur = await conn.execute(f"SELECT count(*) AS n FROM {table} WHERE {where}", params)
        return (await cur.fetchone())["n"]


# ---------------------------------------------------------------------------
# The cipher
# ---------------------------------------------------------------------------
async def test_bytes_round_trip_through_the_checkpointers_cipher(agents_service):
    cipher = _cipher(KEY)
    name, stored = cipher.encrypt(b"quarterly numbers")

    assert name == "aes" and b"quarterly" not in stored
    assert cipher.decrypt(name, stored) == b"quarterly numbers"


async def test_without_a_key_bytes_are_stored_as_they_are_and_stay_readable(agents_service):
    plain, keyed = _cipher(None), _cipher(KEY)

    assert plain.encrypt(b"dev") == ("none", b"dev")
    assert keyed.decrypt("none", b"dev") == b"dev"  # turning encryption on keeps old blobs readable
    with pytest.raises(RuntimeError, match="LANGGRAPH_AES_KEY"):
        plain.decrypt(*keyed.encrypt(b"secret"))


async def test_the_cipher_uses_the_checkpointer_key(agents_service, monkeypatch):
    from pydantic import SecretStr

    module = importlib.import_module("harness.conversation_files.cipher")
    checkpointer = agents_service.settings_module.settings.checkpointer
    monkeypatch.setattr(checkpointer, "aes_key", SecretStr(KEY.decode()))
    module.get_file_cipher.cache_clear()
    assert module.get_file_cipher().encrypted
    monkeypatch.setattr(checkpointer, "aes_key", SecretStr("too-short"))
    module.get_file_cipher.cache_clear()
    with pytest.raises(ValueError, match="16, 24, or 32"):
        module.get_file_cipher()


# ---------------------------------------------------------------------------
# The contract (memory and Postgres)
# ---------------------------------------------------------------------------
async def test_create_writes_once(store):
    assert await store.create("u1", "c1", "/conversation/output/a.md", b"one", agent_slug="omni") == "ok"
    assert await store.create("u1", "c1", "/conversation/output/a.md", b"two", agent_slug="omni") == "exists"
    assert await store.read("u1", "c1", "/conversation/output/a.md") == b"one"


async def test_files_and_directories_cannot_collide(store):
    await store.create("u1", "c1", "/conversation/notes", b"file", agent_slug="omni")
    await store.create("u1", "c1", "/conversation/drafts/v1.md", b"d", agent_slug="omni")

    assert await store.create("u1", "c1", "/conversation/notes/x.md", b"x", agent_slug="omni") == "parent_is_file"
    assert await store.replace("u1", "c1", "/conversation/drafts", b"x", agent_slug="omni") == "is_directory"


async def test_replace_and_edit_change_the_bytes(store):
    await store.create("u1", "c1", "/conversation/output/a.md", b"v1", agent_slug="omni")
    assert await store.replace("u1", "c1", "/conversation/output/a.md", b"v2", agent_slug="nova") == "ok"
    assert await store.edit("u1", "c1", "/conversation/output/a.md", lambda b: b + b"!", agent_slug="omni")
    assert not await store.edit("u1", "c1", "/conversation/output/none.md", lambda b: b, agent_slug="omni")

    entry = await store.stat("u1", "c1", "/conversation/output/a.md")
    assert await store.read("u1", "c1", "/conversation/output/a.md") == b"v2!"
    assert (entry.size, entry.agent_slug) == (3, "omni")


async def test_listing_is_by_prefix_and_never_crosses_users_or_conversations(store):
    for conversation, user, path in [
        ("c1", "u1", "/conversation/output/a.md"),
        ("c1", "u1", "/conversation/output/sub/b.md"),
        ("c1", "u1", "/conversation/output.md"),       # a sibling, not under output/
        ("c1", "u1", "/large_tool_results/call-1"),
        ("c2", "u1", "/conversation/output/other.md"),
        ("c1", "u2", "/conversation/output/theirs.md"),
    ]:
        await store.create(user, conversation, path, path.encode(), agent_slug="omni")

    under_output = [e.path for e in await store.list_files("u1", "c1", "/conversation/output")]

    assert under_output == ["/conversation/output/a.md", "/conversation/output/sub/b.md"]
    assert len(await store.list_files("u1", "c1")) == 4
    assert await store.read("u2", "c1", "/conversation/output/a.md") is None


async def test_a_fork_gets_the_files_and_a_delete_takes_only_its_own(store):
    await store.create("u1", "c1", "/conversation/output/a.md", b"shared", agent_slug="omni")

    assert await store.copy_conversation("u1", "c1", "fork") == 1
    assert await store.copy_conversation("u1", "c1", "fork") == 0  # a retried copy changes nothing
    assert await store.delete_conversation("u1", "c1") == (1, 6)

    assert await store.read("u1", "fork", "/conversation/output/a.md") == b"shared"


async def test_an_account_purge_takes_every_file_of_that_user_only(store):
    await store.create("u1", "c1", "/conversation/a.md", b"a", agent_slug="omni")
    await store.create("u1", "c2", "/conversation/b.md", b"b", agent_slug="omni")
    await store.create("u2", "c3", "/conversation/c.md", b"c", agent_slug="omni")

    assert await store.purge_user("u1") == {"conversation_files": 2, "conversation_file_blobs": 2}
    assert await store.read("u2", "c3", "/conversation/c.md") == b"c"


# ---------------------------------------------------------------------------
# Postgres only: what is actually stored
# ---------------------------------------------------------------------------
async def test_bytes_are_encrypted_at_rest(pg_store, pg_pool):
    await pg_store.create("u1", "c1", "/conversation/output/secret.md", b"the merger closes friday", agent_slug="o")

    async with pg_pool.connection() as conn:
        row = await (await conn.execute("SELECT cipher, data FROM conversation_file_blobs")).fetchone()
    assert row["cipher"] == "aes" and b"merger" not in bytes(row["data"])
    assert await pg_store.read("u1", "c1", "/conversation/output/secret.md") == b"the merger closes friday"


async def test_a_fork_copies_rows_not_bytes(pg_store, pg_pool):
    for index in range(3):
        await pg_store.create("u1", "c1", f"/conversation/output/f{index}.bin", bytes([index]) * 1000, agent_slug="o")

    await pg_store.copy_conversation("u1", "c1", "fork")

    assert await _count(pg_pool, "conversation_files") == 6
    assert await _count(pg_pool, "conversation_file_blobs") == 3  # the same three blobs, named twice


async def test_identical_content_is_stored_once_per_user(pg_store, pg_pool):
    await pg_store.create("u1", "c1", "/conversation/a.md", b"same", agent_slug="o")
    await pg_store.create("u1", "c2", "/conversation/b.md", b"same", agent_slug="o")
    await pg_store.create("u2", "c3", "/conversation/a.md", b"same", agent_slug="o")

    # Never shared across users: one tenant must not learn what another holds.
    assert await _count(pg_pool, "conversation_file_blobs") == 2


async def test_a_blob_goes_with_the_last_row_that_names_it(pg_store, pg_pool):
    await pg_store.create("u1", "c1", "/conversation/output/a.md", b"v1", agent_slug="o")
    await pg_store.copy_conversation("u1", "c1", "fork")

    await pg_store.edit("u1", "c1", "/conversation/output/a.md", lambda b: b"v2", agent_slug="o")
    assert await _count(pg_pool, "conversation_file_blobs") == 2  # v1 still named by the fork

    await pg_store.delete_conversation("u1", "fork")
    assert await _count(pg_pool, "conversation_file_blobs") == 1  # v1 had no name left

    await pg_store.replace("u1", "c1", "/conversation/output/a.md", b"v3", agent_slug="o")
    await pg_store.delete_conversation("u1", "c1")
    assert await _count(pg_pool, "conversation_file_blobs") == 0


async def test_the_table_refuses_paths_outside_the_mounts(pg_pool, pg_store):
    import psycopg

    for path in ("/conversation/input/upload.png", "/elsewhere/x", "/conversation/"):
        with pytest.raises(psycopg.errors.CheckViolation):
            async with pg_pool.connection() as conn:
                await conn.execute(
                    "INSERT INTO conversation_file_blobs (user_id, sha256, size_bytes, cipher, data) "
                    "VALUES ('u1', 'x', 0, 'none', '') ON CONFLICT DO NOTHING"
                )
                await conn.execute(
                    "INSERT INTO conversation_files (conversation_id, path, user_id, sha256, size_bytes, agent_slug) "
                    "VALUES ('c1', %s, 'u1', 'x', 0, 'o')",
                    (path,),
                )
