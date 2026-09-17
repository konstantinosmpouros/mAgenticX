"""add pgvector message_embeddings (per-message semantic embeddings)

Revision ID: 0010_message_embeddings
Revises: 0009_add_scheduled_tasks
Create Date: 2026-06-29

Adds the conversation-embedding storage that powers semantic "most relevant
conversations for a query" retrieval (and, later, cross-chat memory):

- enables the ``vector`` extension (pgvector). Requires the Postgres image to
  ship pgvector — the compose files use ``pgvector/pgvector:pg16``.
- ``message_embeddings`` — one embedding per message (1536-dim, matching the
  agents service ``EMBEDDING_DIMENSIONS`` and ``MessageEmbeddingTable``). Its
  own table (not a column on ``messages``) keeps the hot table lean and lets
  embeddings be regenerated independently. ``ON DELETE CASCADE`` ties each row
  to its message.
- an **HNSW cosine** index for fast ``embedding <=> query`` ordering. Written by
  hand: autogenerate cannot represent the ``vector_cosine_ops`` opclass (same
  blind-spot class as 0009's partial index).

Non-destructive: a brand-new table + extension; no existing row is touched. The
table starts empty — the bridge's embedding sweeper backfills it after deploy.

NOTE: revision id is <= 32 chars (``alembic_version.version_num`` is VARCHAR(32)).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector


revision: str = "0010_message_embeddings"
down_revision: Union[str, None] = "0009_add_scheduled_tasks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Must match agents EMBEDDING_DIMENSIONS and MessageEmbeddingTable. Kept <= 2000
# so HNSW/IVFFlat indexing is allowed (pgvector's index dimension ceiling).
_DIMENSIONS = 1536


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "message_embeddings",
        sa.Column("message_id", sa.String(), primary_key=True),
        sa.Column("embedding", Vector(_DIMENSIONS), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
    )

    # HNSW index for ORDER BY embedding <=> :query (cosine). Hand-written because
    # autogenerate cannot emit the vector opclass.
    op.execute(
        "CREATE INDEX ix_message_embeddings_hnsw "
        "ON message_embeddings USING hnsw (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.drop_index("ix_message_embeddings_hnsw", table_name="message_embeddings")
    op.drop_table("message_embeddings")
    # Intentionally leave the `vector` extension installed: dropping it would
    # fail if anything else references it, and re-creating it is cheap/idempotent.
