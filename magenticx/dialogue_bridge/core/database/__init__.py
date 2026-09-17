"""The SQL data layer: engine/session wiring and ORM models.

Re-exports the full public surface from ``engine`` and ``models`` so callers keep
using ``from core.database import ...`` unchanged after the package split.
"""
from core.database.engine import (
    Base,
    SessionLocal,
    _build_pg_ssl_context,
    b64_decode,
    b64_encode,
    engine,
    gen_uuid,
    get_db,
)
from core.database.models import (
    AgentTable,
    AttachmentTable,
    BlobTable,
    ConversationReportTable,
    ConversationShareTable,
    ConversationTable,
    MessageEmbeddingTable,
    UserAgentToolPrefTable,
    MessageSenderEnum,
    MessageTable,
    ScheduledTaskTable,
    UserPreferencesTable,
    UserTable,
    IdentityConflictError,
    upsert_user_from_identity,
)

__all__ = [
    "AgentTable",
    "AttachmentTable",
    "Base",
    "BlobTable",
    "ConversationReportTable",
    "ConversationShareTable",
    "ConversationTable",
    "IdentityConflictError",
    "MessageEmbeddingTable",
    "MessageSenderEnum",
    "MessageTable",
    "ScheduledTaskTable",
    "SessionLocal",
    "UserAgentToolPrefTable",
    "UserPreferencesTable",
    "UserTable",
    "_build_pg_ssl_context",
    "b64_decode",
    "b64_encode",
    "engine",
    "gen_uuid",
    "get_db",
    "upsert_user_from_identity",
]
