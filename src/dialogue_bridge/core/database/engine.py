"""SQLAlchemy engine, session factory, and the declarative ``Base``.

Owns the async engine wiring — the Postgres verify-full TLS context and the
SQLite-vs-Postgres pool-kwarg split — plus the ``get_db`` FastAPI dependency.
The ORM models live in ``core.database.models`` and import ``Base``/``gen_uuid``
from here; the whole surface is re-exported from ``core.database`` so callers
keep importing ``from core.database import ...`` unchanged.
"""
from uuid import uuid4
import base64
import ssl as _ssl

from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.orm import declarative_base

from core.settings import settings


def gen_uuid() -> str: return str(uuid4())

def b64_encode(b: bytes) -> str: return base64.b64encode(b).decode("ascii")

def b64_decode(s: str) -> bytes: return base64.b64decode(s, validate=True)


def _build_pg_ssl_context() -> _ssl.SSLContext | None:
    ca_path = settings.tls.ca_cert_path
    if not ca_path:
        return None
    ctx = _ssl.create_default_context(cafile=ca_path)
    ctx.check_hostname = True
    ctx.verify_mode = _ssl.CERT_REQUIRED
    return ctx


_pg_ssl_context = _build_pg_ssl_context()

_db_url = settings.database.url.get_secret_value()
_engine_kwargs: dict = {
    "echo": settings.database.echo,
    "pool_pre_ping": settings.database.pool_pre_ping,
    "pool_recycle": settings.database.pool_recycle,
    "connect_args": {"ssl": _pg_ssl_context} if _pg_ssl_context else {},
}
# SQLite (aiosqlite, used by the test suite) runs on NullPool, which rejects the
# queue-pool sizing kwargs; only pass them for real pooled backends (Postgres).
if not _db_url.startswith("sqlite"):
    _engine_kwargs["pool_size"] = settings.database.pool_size
    _engine_kwargs["max_overflow"] = settings.database.max_overflow

engine = create_async_engine(_db_url, **_engine_kwargs)

# Factory that returns AsyncSession objects
SessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    class_=AsyncSession
)

# Base class for all ORM models
Base = declarative_base()

async def get_db() -> AsyncSession: # type: ignore
    """
    FastAPI dependency - yields a database session.
    Usage: `db: AsyncSession = Depends(get_db)`
    """
    async with SessionLocal() as session:
        yield session
