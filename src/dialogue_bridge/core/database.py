from uuid import uuid4
import base64
import ssl as _ssl

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
    Index,
    text,
    UniqueConstraint,
)
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

engine = create_async_engine(
    settings.database.url.get_secret_value(),
    echo=settings.database.echo,
    pool_pre_ping=settings.database.pool_pre_ping,
    pool_recycle=settings.database.pool_recycle,
    pool_size=settings.database.pool_size,
    max_overflow=settings.database.max_overflow,
    connect_args={"ssl": _pg_ssl_context} if _pg_ssl_context else {},
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
    # Lifecycle type — "deep agent", "langgraph agent", "openai agent".
    # Synced from the agents-service manifest; lets the UI filter to
    # features only deep agents support (e.g. per-user skill selection).
    type = Column(String, nullable=False, server_default="langgraph agent")
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
    sessions = relationship(
        "SessionTable",
        back_populates="user",
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
    suggestions_enabled = Column(Boolean, nullable=False, server_default="true")
    voice_mode_voice = Column(String, nullable=False, server_default="alloy")
    voice_mode_language = Column(String, nullable=False, server_default="english")
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    user = relationship("UserTable", back_populates="preferences")


class ConversationTable(Base):
    __tablename__ = "conversations"

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_id = Column(String, ForeignKey("agents.id", ondelete="CASCADE"), nullable=False, index=True)
    forked_parent_id = Column(String, ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True, index=True)
    forked_message_id = Column(String, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True, index=True)

    agent_name = Column(String, nullable=True)
    title = Column(String, nullable=True)
    is_private = Column(Boolean, nullable=False, server_default="false")
    is_archived = Column(Boolean, nullable=False, server_default="false")
    archived_at = Column(DateTime, nullable=True)
    is_reported = Column(Boolean, nullable=False, server_default="false")
    reported_at = Column(DateTime, nullable=True)
    # The assistant message currently being streamed for this conversation.
    # Set when an AI placeholder is created with streaming_status='queued'; cleared
    # by _finish_run when the message reaches a terminal streaming state.
    active_assistant_message_id = Column(String, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True, index=True)

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
        foreign_keys="MessageTable.conversation_id",
        order_by="MessageTable.created_at.asc()",
    )
    report = relationship(
        "ConversationReportTable",
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        uselist=False,
    )
    active_assistant_message = relationship(
        "MessageTable",
        foreign_keys=[active_assistant_message_id],
        post_update=True,
    )


MessageSenderEnum = Enum("user", "ai", name="message_sender_enum")
MessageTypeEnum = Enum("text", "file", "image", "audio", "tool", name="message_type_enum")


class MessageTable(Base):
    __tablename__ = "messages"
    __table_args__ = (
        # At most one assistant message per conversation can be in an active
        # streaming state. Replaces the old inference_runs-table unique index.
        Index(
            "uq_messages_one_active_stream_per_conversation",
            "conversation_id",
            unique=True,
            postgresql_where=text("streaming_status IN ('queued', 'running', 'cancelling')"),
            sqlite_where=text("streaming_status IN ('queued', 'running', 'cancelling')"),
        ),
        Index(
            "ix_messages_streaming_status",
            "streaming_status",
            postgresql_where=text("streaming_status IS NOT NULL"),
            sqlite_where=text("streaming_status IS NOT NULL"),
        ),
    )

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

    # Per-AI-message token usage, summed across every model call + sub-agent in
    # the turn (the true billed consumption — each call re-sends context).
    # Populated only on AI messages produced by an inference run; NULL on user
    # messages and historical rows.
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)

    # error info
    is_error = Column(Boolean, nullable=False, server_default="false")
    error_message = Column(Text, nullable=True)

    # Raw AGUI events sequence for replay/debugging
    raw_events = Column(JSON, nullable=True)           # array of raw AGUI event dicts in order

    # Agent plan and subagent state snapshots
    plan = Column(JSON, nullable=True)                 # last PlanSnapshot state
    subagents = Column(JSON, nullable=True)            # subagent events keyed by task_id

    # Which agent produced this message. Set on AI messages (the run record);
    # NULL on user messages. agent_name is denormalized so a deactivated or
    # removed agent still renders in the per-message action bar. ondelete is
    # SET NULL (not CASCADE like conversations) so deleting an agent never
    # deletes message history — agent_name preserves the label.
    agent_id = Column(String, ForeignKey("agents.id", ondelete="SET NULL"), nullable=True, index=True)
    agent_name = Column(String, nullable=True)

    # ------------------------------------------------------------------
    # Streaming / inference-run state (previously its own InferenceRunTable).
    # These columns are populated only on AI messages that are produced by an
    # inference run. For user messages and historical AI messages produced
    # outside the run framework they stay NULL.
    # ------------------------------------------------------------------
    streaming_status = Column(String, nullable=True)                      # queued / running / cancelling / completed / cancelled / failed
    streaming_message_path = Column(JSON, nullable=True)                  # branch context: list of message IDs the agent saw as history
    streaming_enabled_tools = Column(JSON, nullable=True)                 # tool preferences snapshot at start
    streaming_started_at = Column(DateTime, nullable=True)
    streaming_completed_at = Column(DateTime, nullable=True)
    streaming_cancel_requested_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    conversation = relationship("ConversationTable", back_populates="messages", foreign_keys=[conversation_id])
    attachments = relationship(
        "AttachmentTable",
        back_populates="message",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="AttachmentTable.created_at.asc()",
    )


class ConversationReportTable(Base):
    __tablename__ = "conversation_reports"
    __table_args__ = (UniqueConstraint("conversation_id", name="uq_conversation_reports_conversation_id"),)

    id = Column(String, primary_key=True, default=gen_uuid)
    conversation_id = Column(String, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id = Column(String, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True, index=True)
    reason = Column(String, nullable=False)
    details = Column(Text, nullable=True)
    status = Column(String, nullable=False, server_default="open")
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    conversation = relationship("ConversationTable", back_populates="report")


class ConversationShareTable(Base):
    __tablename__ = "conversation_shares"

    id = Column(String, primary_key=True, default=gen_uuid)
    token = Column(String, nullable=False, unique=True, index=True)
    conversation_id = Column(String, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    owner_user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    snapshot_until_message_id = Column(String, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True, index=True)
    title = Column(String, nullable=True)
    snapshot_json = Column(JSON, nullable=False)
    is_active = Column(Boolean, nullable=False, server_default="true")
    revoked_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True, index=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


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


class SessionTable(Base):
    __tablename__ = "sessions"

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    access_token_hash = Column(String, nullable=False, unique=True, index=True)
    refresh_token_hash = Column(String, nullable=False, unique=True, index=True)
    prev_refresh_token_hash = Column(String, nullable=True, index=True)
    access_expires_at = Column(DateTime, nullable=False)
    refresh_expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    user_agent_hash = Column(String, nullable=True)
    ip_hash = Column(String, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    last_refreshed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

    user = relationship("UserTable", back_populates="sessions")



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
