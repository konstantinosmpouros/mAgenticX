"""add checkpoint lineage columns to messages

Revision ID: 0007_checkpoint_lineage
Revises: 0006_show_message_token_usage
Create Date: 2026-06-22

Adds the durable-checkpointer lineage columns to ``messages`` so the bridge can
map the conversation branch tree onto the agents-service AsyncPostgresSaver:

- ``checkpoint_thread_id`` — the per-branch LangGraph thread a run resumed
  from / created (indexed: looked up to resolve a branch's thread + to reap a
  conversation's threads on delete).
- ``checkpoint_id`` — the durable checkpoint head a run committed (used by
  edit/retry to fork from the right point).

Non-destructive and no backfill: both nullable, all-NULL on existing rows is
correct — those branches have no durable checkpoint and take the full-history
cold-seed path on their next turn, then become full-fidelity.

NOTE: the revision id is kept short — ``alembic_version.version_num`` is
``VARCHAR(32)``, so revision ids must be <= 32 chars.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0007_checkpoint_lineage"
down_revision: Union[str, None] = "0006_show_message_token_usage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("checkpoint_thread_id", sa.String(), nullable=True))
    op.add_column("messages", sa.Column("checkpoint_id", sa.String(), nullable=True))
    op.create_index(
        "ix_messages_checkpoint_thread_id",
        "messages",
        ["checkpoint_thread_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_messages_checkpoint_thread_id", table_name="messages")
    op.drop_column("messages", "checkpoint_id")
    op.drop_column("messages", "checkpoint_thread_id")
