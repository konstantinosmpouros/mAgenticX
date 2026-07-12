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
    MessageSenderEnum,
    MessageTable,
    ScheduledTaskTable,
    UserPreferencesTable,
    UserTable,
    IdentityConflictError,
    upsert_user_from_identity,
)

__all__ = [
    "Base",
    "SessionLocal",
    "engine",
    "get_db",
    "gen_uuid",
    "b64_encode",
    "b64_decode",
    "_build_pg_ssl_context",
    "AgentTable",
    "UserTable",
    "UserPreferencesTable",
    "ConversationTable",
    "MessageTable",
    "MessageEmbeddingTable",
    "MessageSenderEnum",
    "ScheduledTaskTable",
    "ConversationReportTable",
    "ConversationShareTable",
    "AttachmentTable",
    "BlobTable",
    "IdentityConflictError",
    "upsert_user_from_identity",
]
