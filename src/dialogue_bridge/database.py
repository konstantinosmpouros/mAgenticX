import os
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy import Column, String, JSON, ForeignKey

# configurations
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./app.db")
engine = create_async_engine(DATABASE_URL, echo=False)

# Factory that returns AsyncSession objects
SessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine, expire_on_commit=False, class_=AsyncSession
)

# Base class for all ORM models
Base = declarative_base()


async def get_db() -> AsyncSession: # type: ignore
    """
    FastAPI dependency — yields a database session and closes it afterwards.
    Usage: `db: AsyncSession = Depends(get_db)`
    """
    async with SessionLocal() as session:
        yield session

# Database tables
class UserTable(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password = Column(String, nullable=False)

    # one-to-many back-reference
    conversations = relationship(
        "ConversationTable",
        back_populates="user",
        cascade="all, delete-orphan"
    )

class ConversationTable(Base):
    __tablename__ = "conversations"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    conversation_id = Column(String, primary_key=True)
    title = Column(String, nullable=True)
    messages = Column(JSON, nullable=False)

    user = relationship("UserTable", back_populates="conversations")
