import os
from uuid import uuid4
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy import Column, String, JSON, ForeignKey
from sqlalchemy import DateTime, func

# -------------------------------------------------------------------------------
# Configurations
# -------------------------------------------------------------------------------
DATABASE_URL = os.getenv("DATABASE_URL", None)
if DATABASE_URL is None:
    raise Exception("The service wasn't provided with a database url to persist the conversations!")
engine = create_async_engine(DATABASE_URL, echo=False)

# Factory that returns AsyncSession objects
SessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine, expire_on_commit=False, class_=AsyncSession
)

# Base class for all ORM models
Base = declarative_base()

# A function to initialize a session
async def get_db() -> AsyncSession: # type: ignore
    """
    FastAPI dependency — yields a database session and closes it afterwards.
    Usage: `db: AsyncSession = Depends(get_db)`
    """
    async with SessionLocal() as session:
        yield session


# -------------------------------------------------------------------------------
# Database tables
# -------------------------------------------------------------------------------
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
    agents = Column(JSON, nullable=False, default=list)
    
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False
    )
    
    user = relationship("UserTable", back_populates="conversations")


# -------------------------------------------------------------------------------
# Initialize users function
# -------------------------------------------------------------------------------
async def seed_users(session: AsyncSession) -> None:
    """Insert DEFAULT_USERS once; re-runs become no-ops."""
    username = os.getenv("username")
    password = os.getenv("password")
    DEFAULT_USERS = [
        {"username": username, "password": password},
    ]
    for u in DEFAULT_USERS:
        stmt = (
            insert(UserTable)
            .values(
                id=str(uuid4()),
                username=u["username"],
                password=u["password"],
            )
            .on_conflict_do_nothing(index_elements=["username"])
        )
        await session.execute(stmt)
    
    await session.commit()