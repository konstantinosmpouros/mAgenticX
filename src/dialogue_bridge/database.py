import os
from uuid import uuid4
import hashlib

from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func
from sqlalchemy import (
    Column,
    String,
    DateTime,
    Boolean,
    ForeignKey,
    Integer,
    Text,
    JSON,
    Enum,
)


def gen_uuid() -> str: return str(uuid4())

def hash_password(pw: str) -> str: return hashlib.sha256(pw.encode("utf-8")).hexdigest()



# -------------------------------------------------------------------------------
# Configurations
# -------------------------------------------------------------------------------
DATABASE_URL = os.getenv("DATABASE_URL", None)
if DATABASE_URL is None:
    raise Exception("The service wasn't provided with a database url to persist the conversations!")

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_size=5,
    max_overflow=20,
)

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
    FastAPI dependency — yields a database session.
    Usage: `db: AsyncSession = Depends(get_db)`
    """
    async with SessionLocal() as session:
        yield session



# -------------------------------------------------------------------------------
# Database tables
# -------------------------------------------------------------------------------
class UserTable(Base):
    __tablename__ = "users"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    username = Column(String, unique=True, index=True, nullable=False)
    password = Column(String, nullable=False)
    
    email = Column(String, unique=True, index=True, nullable=True)
    display_name = Column(String, nullable=True)
    avatar_url = Column(String, nullable=True)
    
    is_active = Column(Boolean, nullable=False, server_default="true")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    
    # one-to-many back-reference
    conversations = relationship(
        "ConversationTable",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

class ConversationTable(Base):
    __tablename__ = "conversations"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # agent info (denormalized from /agents endpoint)
    agent_id = Column(String, nullable=False)            # e.g., "OrthodoxAI v1"
    agent_name = Column(String, nullable=True)           # e.g., "OrthodoxAI" (for stable UI)
    
    title = Column(String, nullable=True)
    is_private = Column(Boolean, nullable=False, server_default="false")
    
    # for fast conversation list rendering
    last_message_preview = Column(String, nullable=True)
    last_message_at = Column(DateTime, nullable=True)
    
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    
    user = relationship("UserTable", back_populates="conversations")
    messages = relationship(
        "MessageTable",
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="MessageTable.created_at.asc()",
    )

MessageSenderEnum = Enum("user", "agent", "ai", "assistant", name="message_sender_enum")
MessageTypeEnum = Enum("text", "file", "image", "audio", "tool", name="message_type_enum")

class MessageTable(Base):
    __tablename__ = "messages"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    conversation_id = Column(String, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    
    sender = Column(MessageSenderEnum, nullable=False)
    type = Column(MessageTypeEnum, nullable=False, server_default="text")
    content = Column(Text, nullable=True)                  # may be NULL for pure file messages
    
    # Agent "thinking" UX
    reasoning_steps = Column(JSON, nullable=True)          # array[str]
    reasoning_time_seconds = Column(Integer, nullable=True)
    
    # error info
    is_error = Column(Boolean, nullable=False, server_default="false")
    error_message = Column(Text, nullable=True)
    
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    
    conversation = relationship("ConversationTable", back_populates="messages")
    attachments = relationship(
        "AttachmentTable",
        back_populates="message",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="AttachmentTable.created_at.asc()",
    )

class AttachmentTable(Base):
    __tablename__ = "attachments"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    message_id = Column(String, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # what the user sees
    file_name = Column(String, nullable=False)
    mime_type = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=True)
    
    # relative path under your local blob root (e.g., "conversations/<cid>/messages/<mid>/<uuid>_<safe>.bin")
    storage_path = Column(String, nullable=False)
    
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    
    message = relationship("MessageTable", back_populates="attachments")



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
                # id=gen_uuid(),
                id="0123456789",
                username=u["username"],
                password=hash_password(u["password"]),
            )
            .on_conflict_do_nothing(index_elements=["username"])
        )
        await session.execute(stmt)
    
    await session.commit()

