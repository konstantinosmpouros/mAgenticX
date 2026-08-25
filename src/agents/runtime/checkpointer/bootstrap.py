"""Startup bootstrap for the durable LangGraph checkpointer.

Owns the two lifespan steps that stand the checkpointer up: idempotently
creating the ``agent_runtime`` database on a fresh Postgres volume, and opening
the long-lived psycopg pool + wiring the shared ``AsyncPostgresSaver`` into the
process-wide accessor (``store.set_checkpointer``). Lives here — next to the
store and fork helpers — so everything checkpointer-shaped is in one package;
``main._lifespan`` just calls :func:`init_durable_checkpointer`.
"""
import asyncio
import os

import psycopg
from psycopg import conninfo as conninfo_mod, sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.checkpoint.serde.encrypted import EncryptedSerializer
from fastapi import FastAPI

from core.settings import settings
from core.logging import get_logger
from runtime.checkpointer.store import set_checkpointer

logger = get_logger(__name__)


async def _ensure_checkpointer_database(conninfo: str) -> None:
    # Nothing else creates the checkpointer's database: POSTGRES_DB bootstraps
    # only one DB on first init, and AsyncPostgresSaver.setup() creates tables,
    # not the database. On a fresh Postgres volume agent_runtime is therefore
    # absent and the pool can never connect — so create it idempotently via the
    # postgres maintenance DB using the same, already-working credentials.
    params = conninfo_mod.conninfo_to_dict(conninfo)
    target_db = params.get("dbname")
    if not target_db or target_db == "postgres":
        return
    admin_conninfo = conninfo_mod.make_conninfo(
        **{**params, "dbname": "postgres", "connect_timeout": "5"}
    )

    last_error: Exception | None = None
    for _ in range(10):
        try:
            async with await psycopg.AsyncConnection.connect(admin_conninfo, autocommit=True) as conn:
                cursor = await conn.execute(
                    "SELECT 1 FROM pg_database WHERE datname = %s", (target_db,)
                )
                if await cursor.fetchone():
                    return
                try:
                    await conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(target_db)))
                    logger.info(
                        "checkpointer_database_created",
                        "Created missing checkpointer database",
                        database=target_db,
                    )
                except psycopg.errors.DuplicateDatabase:
                    pass
                return
        except psycopg.OperationalError as exc:
            last_error = exc
            await asyncio.sleep(2)
    raise RuntimeError(
        f"Could not reach Postgres to ensure database {target_db!r} exists"
    ) from last_error


async def init_durable_checkpointer(app: FastAPI) -> None:
    """Open the persistent psycopg pool and wire the shared AsyncPostgresSaver.

    The pool is long-lived and shared across all requests; each request selects
    its thread via ``run_config.configurable.thread_id``. The pool is parked on
    ``app.state.checkpointer_pool`` so the lifespan can close it on shutdown.
    """
    cfg = settings.checkpointer

    await _ensure_checkpointer_database(cfg.url.get_secret_value())

    # The langgraph lib reads this from the environment; mirror the setting so a
    # missing compose env can't silently disable the strict allow-list.
    if cfg.strict_msgpack:
        os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

    conn_kwargs = {
        "autocommit": True,           # required: setup() + CREATE INDEX CONCURRENTLY
        "row_factory": dict_row,      # required: reads must be dict rows
        "prepare_threshold": None,    # pgbouncer-safe; no server-side prepared stmts
        # TCP keepalives: the Swarm overlay network on Dennis silently drops TCP
        # flows idle for ~15 min, leaving pooled connections half-dead ("SSL
        # SYSCALL error: EOF detected" on first use). Probing every 5 idle
        # minutes keeps the flow tracked and detects dead peers early.
        "keepalives": 1,
        "keepalives_idle": 300,
        "keepalives_interval": 30,
        "keepalives_count": 3,
    }
    pool = AsyncConnectionPool(
        conninfo=cfg.url.get_secret_value(),
        min_size=cfg.pool_min_size,
        max_size=cfg.pool_max_size,
        max_idle=cfg.pool_max_idle,
        timeout=cfg.pool_timeout,
        open=False,
        kwargs=conn_kwargs,
        # Health-check connections at checkout (the psycopg_pool equivalent of
        # the bridge engine's pool_pre_ping): a connection that died while idle
        # is discarded and replaced instead of surfacing an OperationalError.
        check=AsyncConnectionPool.check_connection,
    )
    await pool.open()
    await pool.wait()
    app.state.checkpointer_pool = pool

    serde = None
    aes_key = cfg.aes_key.get_secret_value()
    if aes_key:
        os.environ.setdefault("LANGGRAPH_AES_KEY", aes_key)
        serde = EncryptedSerializer.from_pycryptodome_aes()

    if cfg.setup_on_startup:
        # Serialize concurrent multi-replica setup() (the index migrations use
        # CREATE INDEX CONCURRENTLY, which can't run in a txn block and would
        # collide). Single-replica today, so this is belt-and-suspenders.
        async with pool.connection() as conn:
            await conn.execute("SELECT pg_advisory_lock(hashtext('langgraph_setup'))")
            try:
                await AsyncPostgresSaver(conn).setup()
            finally:
                await conn.execute("SELECT pg_advisory_unlock(hashtext('langgraph_setup'))")

    checkpointer = AsyncPostgresSaver(pool) if serde is None else AsyncPostgresSaver(pool, serde=serde)
    app.state.checkpointer = checkpointer
    set_checkpointer(checkpointer)
    logger.info(
        "checkpointer_initialized",
        "Durable AsyncPostgresSaver initialized",
        encrypted=serde is not None,
        setup_ran=cfg.setup_on_startup,
        pool_max_size=cfg.pool_max_size,
    )
