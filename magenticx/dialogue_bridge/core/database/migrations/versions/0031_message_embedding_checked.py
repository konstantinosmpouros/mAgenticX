"""messages.embedding_checked_at + a partial index: the embedding sweeper's queue

Revision ID: 0031_message_embedding_checked
Revises: 0030_attachment_blob_trigger
Create Date: 2026-10-06

The sweeper used to find work with ``messages LEFT JOIN message_embeddings …
IS NULL`` on every pass — a scan of every message, carrying each one's content
through the join. With a 200k-message backlog that hash join spilled to disk on
every pass (4.4 GB of temp files), and with no backlog it still scanned every
message every few seconds, forever.

``embedding_checked_at`` marks a message the sweeper has looked at, embedded or
found not embeddable; ``ix_messages_embedding_pending`` indexes only the ones it
has not. A pass now reads one batch off that index.

Backfill: messages that already have an embedding are marked checked (at the
time they were embedded). Everything else stays queued, and the sweeper either
embeds it or marks it not embeddable on its first look.

Additive: one nullable column, one partial index. Nothing is deleted.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0031_message_embedding_checked"
down_revision: Union[str, None] = "0030_attachment_blob_trigger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("embedding_checked_at", sa.DateTime(), nullable=True))
    op.execute(
        "UPDATE messages SET embedding_checked_at = e.created_at "
        "FROM message_embeddings e WHERE e.message_id = messages.id"
    )
    op.create_index(
        "ix_messages_embedding_pending",
        "messages",
        ["created_at"],
        postgresql_where=sa.text("embedding_checked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_messages_embedding_pending", table_name="messages")
    op.drop_column("messages", "embedding_checked_at")
