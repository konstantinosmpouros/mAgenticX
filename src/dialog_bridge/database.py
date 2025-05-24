import os
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.orm import declarative_base

# configurations
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./app.db")
engine = create_async_engine(DATABASE_URL, echo=False)

# Factory that returns AsyncSession objects
SessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine, expire_on_commit=False, class_=AsyncSession
)

# Base class for all ORM models
Base = declarative_base()


async def get_db() -> AsyncSession:
    """
    FastAPI dependency — yields a database session and closes it afterwards.
    Usage: `db: AsyncSession = Depends(get_db)`
    """
    async with SessionLocal() as session:
        yield session