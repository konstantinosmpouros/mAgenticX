import os
from uuid import uuid4
import base64

from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func
from sqlalchemy import select
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
    LargeBinary,
    UniqueConstraint,
)


def gen_uuid() -> str: return str(uuid4())

def b64_encode(b: bytes) -> str: return base64.b64encode(b).decode("ascii")

def b64_decode(s: str) -> bytes: return base64.b64decode(s, validate=True)



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
    FastAPI dependency - yields a database session.
    Usage: `db: AsyncSession = Depends(get_db)`
    """
    async with SessionLocal() as session:
        yield session



# -------------------------------------------------------------------------------
# Database tables
# -------------------------------------------------------------------------------
class AgentTable(Base):
    __tablename__ = "agents"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    slug = Column(String, nullable=False, unique=True)
    name = Column(String, nullable=False)
    description = Column(String, nullable=False)
    icon = Column(String, nullable=False)
    version = Column(String, nullable=True)
    is_active = Column(Boolean, nullable=False, server_default="true")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    
    conversations = relationship(
        "ConversationTable",
        back_populates="agent",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class UserTable(Base):
    __tablename__ = "users"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    username = Column(String, unique=True, index=True, nullable=False)
    vault_user_id = Column(String, unique=True, index=True, nullable=False)
    
    email = Column(String, unique=True, index=True, nullable=True)
    display_name = Column(String, nullable=True)
    avatar_url = Column(String, nullable=True)
    full_name = Column(String, nullable=True)
    department = Column(String, nullable=True)
    role_title = Column(String, nullable=True)
    last_login_at = Column(DateTime, nullable=True)

    is_active = Column(Boolean, nullable=False, server_default="true")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    preferences = relationship(
        "UserPreferencesTable",
        back_populates="user",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    
    # one-to-many back-reference
    conversations = relationship(
        "ConversationTable",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class UserPreferencesTable(Base):
    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("user_id", name="uq_user_preferences_user_id"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    tools = Column(JSON, nullable=False, default=dict)
    prefers_agentic_chat = Column(Boolean, nullable=False, server_default="false")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    user = relationship("UserTable", back_populates="preferences")


class ConversationTable(Base):
    __tablename__ = "conversations"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_id = Column(String, ForeignKey("agents.id", ondelete="CASCADE"), nullable=False, index=True)
    
    agent_name = Column(String, nullable=True)
    title = Column(String, nullable=True)
    is_private = Column(Boolean, nullable=False, server_default="false")
    
    # for fast conversation list rendering
    last_message_preview = Column(String, server_default="", nullable=True)
    last_message_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    
    user = relationship("UserTable", back_populates="conversations")
    agent = relationship("AgentTable", back_populates="conversations")
    messages = relationship(
        "MessageTable",
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="MessageTable.created_at.asc()",
    )


MessageSenderEnum = Enum("user", "ai", name="message_sender_enum")
MessageTypeEnum = Enum("text", "file", "image", "audio", "tool", name="message_type_enum")


class MessageTable(Base):
    __tablename__ = "messages"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    conversation_id = Column(String, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_message_id = Column(String, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True, index=True)
    
    sender = Column(MessageSenderEnum, nullable=False)
    type = Column(MessageTypeEnum, nullable=False, server_default="text")
    content = Column(Text, nullable=True)                  # may be NULL for pure file messages
    
    # User feedback: nullable boolean => None (no feedback), True (like), False (dislike)
    liked = Column(Boolean, nullable=True)
    
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
    
    # Blob file
    blob_id = Column(String, ForeignKey("blobs.id", ondelete="CASCADE"), nullable=True, index=True)
    
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)
    
    message = relationship("MessageTable", back_populates="attachments")
    blob = relationship("BlobTable", back_populates="attachment", cascade="all, delete-orphan", uselist=False, single_parent=True)


class BlobTable(Base):
    __tablename__ = "blobs"
    
    id = Column(String, primary_key=True, default=gen_uuid)
    data = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    
    # Back-reference for the 1:1 relationship
    attachment = relationship("AttachmentTable", back_populates="blob", uselist=False)



# -------------------------------------------------------------------------------
# User helpers
# -------------------------------------------------------------------------------
async def upsert_user_from_vault(
    session: AsyncSession,
    *,
    vault_user_id: str,
    username: str,
    metadata: dict | None = None,
) -> UserTable:
    """
    Ensure a Vault-authenticated user exists locally.
    - Creates a new user row when first seen.
    - Updates mutable profile fields on subsequent logins.
    """
    metadata = metadata or {}

    result = await session.execute(
        select(UserTable).where(
            UserTable.vault_user_id == vault_user_id,
            UserTable.is_active == True,
        )
    )
    user: UserTable | None = result.scalar_one_or_none()

    if user is None:
        user = UserTable(
            id=gen_uuid(),
            vault_user_id=vault_user_id,
            username=username,
        )
        session.add(user)
        # Flush early so relationships can reference the user within the same transaction.
        await session.flush()

    # Always refresh username to keep local record aligned with Vault.
    user.username = username

    # Update selected metadata only when the Vault response includes a value.
    mutable_fields = (
        "email",
        "display_name",
        "avatar_url",
        "full_name",
        "department",
        "role_title",
    )
    for field in mutable_fields:
        if field in metadata and metadata[field] is not None:
            setattr(user, field, metadata[field])

    if "last_login_at" in metadata and metadata["last_login_at"] is not None:
        user.last_login_at = metadata["last_login_at"]

    return user


