import os
from uuid import uuid4
import hashlib
import base64

from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func
from sqlalchemy import text
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
)


def gen_uuid() -> str: return str(uuid4())

def hash_password(pw: str) -> str: return hashlib.sha256(pw.encode("utf-8")).hexdigest()

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
    FastAPI dependency — yields a database session.
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
    name = Column(String, nullable=False)
    description = Column(String, nullable=False)
    icon = Column(String, nullable=False)
    url = Column(String, nullable=False)
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
# Seed the DB with data in the initialization
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
                id=gen_uuid(),
                # id="0123456789",
                username=u["username"],
                password=hash_password(u["password"]),
            )
            .on_conflict_do_nothing(index_elements=["username"])
        )
        await session.execute(stmt)
    
    await session.commit()


async def seed_agents(session: AsyncSession) -> None:
    """Insert the default agents in the initialization of the db"""
    DEFAULT_AGENTS = [
        {
            "id": "OrthodoxAI v1",
            "name": "OrthodoxAI",
            "description": "Orthodox biblical and theological insights",
            "icon": "BookOpen",
            "url": "http://agents:8003/OrthodoxAI/v1/stream",
            "is_active": True
        },
        {
            "id": "HR-Policies v1",
            "name": "HR Policies",
            "description": "HR policies, leave, benefits, and procedures",
            "icon": "Building2",
            "url": "http://agents:8003/HRPolicies/v1/stream",
            "is_active": True
        },
        {
            "id": "Retail Agent v1",
            "name": "Retail Agent",
            "description": "Product discovery, pricing, inventory and promotions",
            "icon": "ShoppingBag",
            "url": "http://agents:8003/Retail/v1/stream",
            "is_active": True
        },
    ]
    
    for a in DEFAULT_AGENTS:
        stmt = (
            insert(AgentTable)
            .values(
                id=a["id"],
                name=a["name"],
                description=a["description"],
                icon=a["icon"],
                url=a["url"],
                is_active=a["is_active"]
            )
            .on_conflict_do_nothing(index_elements=["id"])
        )
        await session.execute(stmt)
    
    await session.commit()

