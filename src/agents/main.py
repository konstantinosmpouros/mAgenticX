# Path setup
from pathlib import Path
import os
import sys

PACKAGE_ROOT = Path(os.path.abspath(os.path.dirname(__file__)))
sys.path.append(str(PACKAGE_ROOT))


import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from core.settings import settings
from runtime.checkpointer import set_checkpointer
from observability import (
    RequestLoggingMiddleware,
    configure_logging,
    get_logger,
    register_exception_handlers,
    shutdown_logging,
)
from runtime.skill_registry import (
    rebuild_global_manifest,
    reconcile_all_user_manifests,
    seed_global_registry,
)
from router.catalog import router as catalog_router
from router.generation import router as generation_router
from router.inference import router as inference_router
from router.skills import router as skills_router
from router.voice import router as voice_router


configure_logging()
logger = get_logger(__name__)


def _make_loop_exception_handler(old_handler=None):
    def handler(loop, context):
        ex = context.get("exception")
        # Silently ignore common disconnect/cancel noise
        if isinstance(ex, (asyncio.CancelledError, BrokenPipeError, ConnectionResetError)):
            return
        # Suppress LangGraph uvloop callback noise on cancellation
        handle = context.get("handle") or context.get("task")
        msg = context.get("message", "")
        text = f"{msg} {handle!r}"
        if isinstance(ex, TypeError) and "NoneType" in str(ex) and "langgraph" in text:
            return
        logger.error(
            "event_loop_exception",
            "Unhandled event loop exception",
            exc_info=bool(ex),
            exception_type=type(ex).__name__ if ex is not None else None,
            loop_message=msg or None,
        )
        if old_handler is not None:
            try:
                old_handler(loop, context)
                return
            except Exception:
                pass
        loop.default_exception_handler(context)
    return handler


async def _ensure_checkpointer_database(conninfo: str) -> None:
    # Nothing else creates the checkpointer's database: POSTGRES_DB bootstraps
    # only one DB on first init, and AsyncPostgresSaver.setup() creates tables,
    # not the database. On a fresh Postgres volume agent_runtime is therefore
    # absent and the pool can never connect — so create it idempotently via the
    # postgres maintenance DB using the same, already-working credentials.
    import psycopg
    from psycopg import conninfo as conninfo_mod, sql

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


async def _init_durable_checkpointer(app: FastAPI) -> None:
    """Open the persistent psycopg pool and wire the shared AsyncPostgresSaver.

    Heavy deps (psycopg, langgraph-checkpoint-postgres) are imported lazily here
    so importing ``main`` (e.g. in unit tests that never run the lifespan) does
    not require them. The pool is long-lived and shared across all requests;
    each request selects its thread via ``run_config.configurable.thread_id``.
    """
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

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
    }
    pool = AsyncConnectionPool(
        conninfo=cfg.url.get_secret_value(),
        min_size=cfg.pool_min_size,
        max_size=cfg.pool_max_size,
        max_idle=cfg.pool_max_idle,
        timeout=cfg.pool_timeout,
        open=False,
        kwargs=conn_kwargs,
    )
    await pool.open()
    await pool.wait()
    app.state.checkpointer_pool = pool

    serde = None
    aes_key = cfg.aes_key.get_secret_value()
    if aes_key:
        from langgraph.checkpoint.serde.encrypted import EncryptedSerializer

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


@asynccontextmanager
async def _lifespan(app: FastAPI):
    loop = asyncio.get_event_loop()
    old = loop.get_exception_handler()
    loop.set_exception_handler(_make_loop_exception_handler(old))
    pool = None
    try:
        logger.info("service_startup", "Agents service startup initiated")
        # Bootstrap the global skills registry volume from the image seed,
        # index it into manifest.json, then heal per-user manifests against
        # filesystem state.
        seed_global_registry()
        rebuild_global_manifest()
        reconcile_all_user_manifests()
        # Durable checkpointer — fail fast and loud if agent_runtime is
        # unreachable; cross-turn resume depends on it.
        await _init_durable_checkpointer(app)
        pool = app.state.checkpointer_pool
        yield
    finally:
        if pool is not None:
            await pool.close()
        loop.set_exception_handler(old)
        logger.info("service_shutdown", "Agents service shutdown completed")
        shutdown_logging()


app = FastAPI(lifespan=_lifespan, title="Agents Service")
register_exception_handlers(app)
app.add_middleware(RequestLoggingMiddleware)


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


app.include_router(catalog_router)
app.include_router(generation_router)
app.include_router(inference_router)
app.include_router(skills_router)
app.include_router(voice_router)
