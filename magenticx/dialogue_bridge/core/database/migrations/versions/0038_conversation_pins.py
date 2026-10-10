"""Pinned conversations: conversations.is_pinned + pinned_at

Revision ID: 0038_conversation_pins
Revises: 0037_user_avatars
Create Date: 2026-10-10

The sidebar gains a Pinned section above Chats. Every conversation carries an
is_pinned flag (false by default) and the time it was pinned, which orders the
section. A partial index over the pinned rows serves that list: pins are a
handful per user, so the index stays tiny however long the history grows.

Additive only: two columns with safe defaults. Every existing conversation
starts unpinned, so nothing to backfill.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0038_conversation_pins"
down_revision: Union[str, None] = "0037_user_avatars"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("is_pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column("conversations", sa.Column("pinned_at", sa.DateTime(), nullable=True))
    # Hand-written: autogenerate does not see partial-index predicates.
    op.create_index(
        "ix_conversations_user_pinned",
        "conversations",
        ["user_id", "pinned_at"],
        postgresql_where=sa.text("is_pinned"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_user_pinned", table_name="conversations")
    op.drop_column("conversations", "pinned_at")
    op.drop_column("conversations", "is_pinned")
