"""Alembic environment for dialogue_bridge.

Uses a **synchronous** engine (psycopg2) for migrations even though the
application itself runs on asyncpg. This keeps the migration tool out of the
async stack so the lifespan startup can dispatch it via ``asyncio.to_thread``
without nesting an inner ``asyncio.run`` call — that nesting deadlocks
because asyncpg and the outer loop share state across threads.

The database URL and SSL configuration are sourced from :mod:`core.settings`
at runtime; the URL is rewritten from ``postgresql+asyncpg://...`` to
``postgresql+psycopg2://...`` so SQLAlchemy picks the sync driver.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool
from sqlalchemy.engine import Connection

# Importing core.database registers every ORM model on Base.metadata.
from core.database import Base, _build_pg_ssl_context  # noqa: F401
from core.settings import settings


config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _sync_database_url() -> str:
    """Resolve DATABASE_URL and swap the async driver for the sync one.

    psycopg2 understands the same DSN, so the rewrite is purely a driver
    selection. The application's asyncpg engine in ``core.database`` is
    untouched.
    """
    url = settings.database.url.get_secret_value()
    return url.replace("postgresql+asyncpg://", "postgresql+psycopg2://", 1)


def _sync_connect_args() -> dict:
    """Translate the project's SSLContext into psycopg2 connect args.

    psycopg2 doesn't accept a ``ssl=SSLContext`` argument; instead it reads
    standard libpq env vars / DSN keywords (``sslmode``, ``sslrootcert``).
    When the project's SSL context is set, we ask psycopg2 to use
    ``verify-full`` with the same CA path the async engine uses.
    """
    ctx = _build_pg_ssl_context()
    if ctx is None:
        return {}
    return {
        "sslmode": "verify-full",
        "sslrootcert": settings.tls.ca_cert_path,
    }


def run_migrations_offline() -> None:
    """Emit SQL to stdout without a live DB connection."""
    context.configure(
        url=_sync_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(
        _sync_database_url(),
        poolclass=pool.NullPool,
        connect_args=_sync_connect_args(),
    )
    with connectable.connect() as connection:
        do_run_migrations(connection)
    connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
