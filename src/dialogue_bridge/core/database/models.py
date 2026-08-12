"""ORM table definitions (SQLAlchemy models) for the dialogue_bridge database.

Every table model plus the ``upsert_user_from_identity`` helper. ``Base`` and
``gen_uuid`` come from ``core.database.engine``; the whole surface is re-exported
from ``core.database`` so callers keep importing ``from core.database import ...``.
"""
from sqlalchemy.orm import relationship
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
from sqlalchemy.ext.asyncio import AsyncSession
from pgvector.sqlalchemy import Vector

from core.database.engine import Base, gen_uuid


# Embedding vector size. Must match the agents service EMBEDDING_DIMENSIONS and
# the dimension baked into migration 0010 (the pgvector column type is fixed at
# DDL time — changing this requires a new migration + a full re-embed).
EMBEDDING_DIMENSIONS = 1536


# -------------------------------------------------------------------------------
# Database tables
# -------------------------------------------------------------------------------
class AgentTable(Base):
    __tablename__ = "agents"
    __table_args__ = (
        # A user may not have two agents with the same slug…
        UniqueConstraint("owner_user_id", "slug", name="uq_agents_owner_slug"),
        # …and platform slugs stay globally unique. A plain composite constraint
        # is not enough: Postgres allows unlimited NULLs in a unique index, so
        # without this partial index two platform agents could share a slug.
        Index(
            "uq_agents_global_slug",
            "slug",
            unique=True,
            postgresql_where=text("owner_user_id IS NULL"),
        ),
    )

    id = Column(String, primary_key=True, default=gen_uuid)
    # NULL = a platform agent discovered from the agents-service manifest.
    # Set = a user-authored agent whose definition lives in that user's
    # workspace (`custom_agents/<slug>/agent.yaml`). Drives both the agents
    # service's resolution path and every ownership check.
    owner_user_id = Column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    slug = Column(String, nullable=False)
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
    # Per-provider external subject ids. Both are nullable+unique so ONE row can
    # be linked to multiple login methods (see upsert_user_from_identity): a
    # Vault-only user has oidc_subject NULL, an Entra-only user has vault_user_id
    # NULL, and a linked user carries both. Postgres allows many NULLs under a
    # unique index, so unlinked rows never collide.
    vault_user_id = Column(String, unique=True, index=True, nullable=True)
    oidc_subject = Column(String, unique=True, index=True, nullable=True)
    # Comma-separated set of login methods proven for this account ("vault",
    # "entra"), for observability/debugging — the subject columns are authoritative.
    auth_providers = Column(String, nullable=True)

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
    prefers_agentic_chat = Column(Boolean, nullable=False, server_default="false")
    suggestions_enabled = Column(Boolean, nullable=False, server_default="true")
    show_message_token_usage = Column(Boolean, nullable=False, server_default="false")
    # Opt-in (default false): when true, deep agents get the cross-conversation
    # `search_past_conversations` memory tool. Threaded into the run config so the
    # agent only attaches the tool when this user has enabled it.
    search_past_convs = Column(Boolean, nullable=False, server_default="false")
    # On by default: when false, deep agents skip their persistent memory (the
    # AGENT.md `/memories/` mount + future memory folder) for the run. Threaded
    # into the run config so memory can be disabled per user without code change.
    use_memory = Column(Boolean, nullable=False, server_default="true")
    # Personality preset id for agent responses ("default" = the agent's own
    # voice, no injected directive). Normalized fail-closed against the preset
    # registry at the API boundary; the agents service re-validates on its side.
    personality = Column(String, nullable=False, server_default="default")
    # User-authored custom instructions: {enabled, nickname, occupation, traits,
    # about}. Threaded into the run context and injected into deep-agent system
    # prompts only while `enabled` is true.
    custom_instructions = Column(JSON, nullable=False, default=dict, server_default="{}")
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

    # ------------------------------------------------------------------
    # Durable checkpointer lineage (agents-service AsyncPostgresSaver).
    # Set only on AI messages produced by an inference run; NULL on user
    # messages and on AI messages that predate this migration (those branches
    # have no durable checkpoint and take the full-history cold-seed path on
    # their next turn, then become full-fidelity).
    #
    # checkpoint_thread_id — the per-branch LangGraph thread this run resumed
    #   from / created. Shared across every run that linearly extends the same
    #   root->leaf branch; a fresh id is minted on new/edit/retry/shared_continue.
    # checkpoint_id — the durable checkpoint head this run committed (captured
    #   from the agent's CHECKPOINT_COMMITTED event). The next `send` resumes
    #   from here; edit/retry fork from the target ancestor's head.
    # ------------------------------------------------------------------
    checkpoint_thread_id = Column(String, nullable=True, index=True)
    checkpoint_id = Column(String, nullable=True)

    # Raw AGUI events sequence for replay/debugging
    raw_events = Column(JSON, nullable=True)           # array of raw AGUI event dicts in order

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
    streaming_started_at = Column(DateTime, nullable=True)
    streaming_completed_at = Column(DateTime, nullable=True)
    streaming_cancel_requested_at = Column(DateTime, nullable=True)

    # Set on AI run messages produced by a scheduled-task fire; NULL on every
    # other message. This is the durable "this run came from task X" tag — the
    # source of truth for the panel's live-status query and per-task run history
    # (Redis only carries the live frames and expires them). ondelete is SET NULL
    # so deleting a task never deletes the runs/results it produced.
    scheduled_task_id = Column(String, ForeignKey("scheduled_tasks.id", ondelete="SET NULL"), nullable=True, index=True)

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

    # Provenance: "upload" for user-attached files, "generated" for a deliverable
    # the agent designated via present_artifact. The frontend renders the two
    # differently (generated files carry the agent-supplied title/summary and
    # left-align on the assistant message). Defaults to "upload" so every
    # pre-existing row is unambiguous.
    origin = Column(String, nullable=False, server_default="upload")
    # Agent-supplied display metadata — populated for generated artifacts only.
    title = Column(String, nullable=True)
    summary = Column(String, nullable=True)

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


class ScheduledTaskTable(Base):
    """A user-owned recurring/one-off agent job the scheduler fires headlessly.

    A fire reuses the normal inference pipeline (``start_inference_flow`` +
    ``inference_run_manager.launch``), so the produced result is just an AI
    ``MessageTable`` row tagged with this task's id (``messages.scheduled_task_id``)
    — there is no parallel result store. The columns here describe the *schedule*
    (lifecycle, cadence, target), not a run; a run's own lifecycle stays on its
    message's ``streaming_*`` columns.
    """
    __tablename__ = "scheduled_tasks"
    __table_args__ = (
        # The scheduler's hot poll: due active tasks. Partial so only firable
        # rows are indexed (mirrors ix_messages_streaming_status's style).
        Index(
            "ix_scheduled_tasks_due",
            "next_run_at",
            postgresql_where=text("status = 'active'"),
            sqlite_where=text("status = 'active'"),
        ),
    )

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # Agent attribution mirrors messages: SET NULL + denormalized name/slug so
    # deactivating or deleting an agent never deletes the schedule. The slug is
    # the rename-stable handle used to re-resolve the agent if its id goes NULL.
    agent_id = Column(String, ForeignKey("agents.id", ondelete="SET NULL"), nullable=True, index=True)
    agent_name = Column(String, nullable=True)
    agent_slug = Column(String, nullable=True)

    # Bound mode only: the dedicated conversation the task appends to (minted on
    # the first fire, reused after). SET NULL so deleting the conversation doesn't
    # delete the task — the next fire detects the gap and pauses with last_error.
    conversation_id = Column(String, ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True, index=True)

    title = Column(String, nullable=True)
    # The instruction fed to the agent on every fire (the synthetic user turn).
    prompt = Column(Text, nullable=False)
    is_private = Column(Boolean, nullable=False, server_default="false")

    # 'fresh' = new conversation each fire (isolated); 'bound' = one dedicated
    # conversation, append each fire (cross-fire memory via the durable checkpointer).
    target_mode = Column(String, nullable=False, server_default="fresh")

    # 'one_off' | 'interval' | 'cron'. schedule_spec holds the kind's params:
    #   one_off  -> {"run_at": "<iso>"}
    #   interval -> {"interval_seconds": <int>}
    #   cron     -> {"cron_expr": "<expr>"}
    # timezone (IANA) makes a cron expression meaningful; stored next_run_at stays naive-UTC.
    schedule_kind = Column(String, nullable=False)
    schedule_spec = Column(JSON, nullable=False, default=dict)
    timezone = Column(String, nullable=True)

    # Schedule lifecycle, distinct from a run's streaming_status:
    # 'active' | 'paused' | 'completed' | 'failed'.
    status = Column(String, nullable=False, server_default="active")
    # The scheduler's poll target (naive-UTC). Partial-indexed WHERE status='active'.
    next_run_at = Column(DateTime, nullable=True)
    last_run_at = Column(DateTime, nullable=True)
    # Outcome of the most recent fire: completed | failed | cancelled | skipped.
    last_run_status = Column(String, nullable=True)
    # The AI message the most recent fire produced (NULL if it produced none —
    # e.g. busy-skipped or the agent was gone). Plain String, not an FK, on
    # purpose: an FK here would close a messages->scheduled_tasks->conversations
    # ->messages cycle. The live status of the latest fire is derived by looking
    # this message up (its streaming_status), so the task row never goes stale.
    last_run_message_id = Column(String, nullable=True)
    # Fire-time failures that never produce a message (agent gone, bound-conv
    # deleted, watchdog timeout, busy-skip) so the UI can explain a stuck task.
    last_error = Column(Text, nullable=True)

    run_count = Column(Integer, nullable=False, server_default="0")
    max_runs = Column(Integer, nullable=True)
    expires_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class MessageEmbeddingTable(Base):
    """One semantic embedding per message (pgvector), used to find the most
    relevant past conversations for a query — the foundation for cross-chat
    retrieval and memory.

    Kept in its own table (not a column on ``messages``) so the hot message
    table stays lean and embeddings can be regenerated/versioned independently.
    Populated asynchronously by the embedding sweeper (``utils/embeddings.py``),
    never on the request path. Rows are created only for finalized, non-error
    messages with non-empty content whose conversation is **not** private;
    deleting a message cascades to its embedding.

    The HNSW cosine index lives in migration 0010 (hand-written — autogenerate
    cannot represent the ``vector_cosine_ops`` opclass).
    """
    __tablename__ = "message_embeddings"

    message_id = Column(
        String,
        ForeignKey("messages.id", ondelete="CASCADE"),
        primary_key=True,
    )
    embedding = Column(Vector(EMBEDDING_DIMENSIONS), nullable=False)
    # The model that produced this vector, so a future model swap can re-embed
    # selectively rather than wiping the whole table.
    model = Column(String, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


# -------------------------------------------------------------------------------
# User helpers
# -------------------------------------------------------------------------------
# Maps an auth provider to the UserTable column that stores its external subject
# id. Adding a third provider (e.g. Keycloak) is a one-line addition here.
_PROVIDER_SUBJECT_COLUMN = {"vault": "vault_user_id", "entra": "oidc_subject"}


class IdentityConflictError(Exception):
    """A login could not be linked because the email is already bound to a
    DIFFERENT subject for the same provider. Raised (and surfaced as an auth
    failure) rather than silently merging or duplicating an account."""


def _normalize_email(email: str | None) -> str | None:
    email = (email or "").strip().lower()
    return email or None


async def upsert_user_from_identity(
    session: AsyncSession,
    *,
    provider: str,
    subject: str,
    username: str,
    email: str | None = None,
    metadata: dict | None = None,
) -> UserTable:
    """Resolve (or create) the single canonical user row for an authenticated
    identity, LINKING login methods so the same human never gets two rows.

    Resolution order:
      1. by this provider's subject id — the user has signed in this way before;
      2. else by verified email — an account already exists (created via the
         other provider); attach this provider's subject to it (the link step);
      3. else create a fresh row carrying this provider's subject.

    Email is the cross-provider link key and is trustworthy here because every
    provider (single-tenant Entra, org-provisioned Vault) is authoritative for
    it. A subject/email clash fails closed via :class:`IdentityConflictError`.
    """
    if provider not in _PROVIDER_SUBJECT_COLUMN:
        raise ValueError(f"Unknown auth provider: {provider!r}")
    subject_col = _PROVIDER_SUBJECT_COLUMN[provider]
    metadata = metadata or {}
    email_norm = _normalize_email(email)

    # 1. Already known via this provider.
    result = await session.execute(
        select(UserTable).where(getattr(UserTable, subject_col) == subject)
    )
    user: UserTable | None = result.scalar_one_or_none()

    # 2. Not yet — try to link to an existing account by email.
    if user is None and email_norm:
        result = await session.execute(
            select(UserTable).where(func.lower(UserTable.email) == email_norm)
        )
        user = result.scalar_one_or_none()
        if user is not None:
            bound = getattr(user, subject_col)
            if bound is not None and bound != subject:
                raise IdentityConflictError(
                    f"email already linked to a different {provider} subject"
                )
            setattr(user, subject_col, subject)  # link this provider to the row

    # 3. Brand-new human.
    if user is None:
        user = UserTable(id=gen_uuid(), username=username, email=email_norm)
        setattr(user, subject_col, subject)
        session.add(user)
        # Flush early so relationships can reference the user within the same transaction.
        await session.flush()

    # Record which login methods now resolve to this account.
    providers = {p for p in (user.auth_providers or "").split(",") if p}
    providers.add(provider)
    user.auth_providers = ",".join(sorted(providers))

    # Set username/email only when missing, to avoid clobbering a value the other
    # provider owns (username is unique — overwriting could collide).
    if not user.username:
        user.username = username
    if email_norm and not user.email:
        user.email = email_norm

    # Refresh mutable profile fields when the provider supplied them (email is
    # handled above — never overwritten here, to avoid a unique-constraint clash).
    for field in ("display_name", "avatar_url", "full_name", "department", "role_title"):
        if metadata.get(field) is not None:
            setattr(user, field, metadata[field])

    if metadata.get("last_login_at") is not None:
        user.last_login_at = metadata["last_login_at"]

    return user
