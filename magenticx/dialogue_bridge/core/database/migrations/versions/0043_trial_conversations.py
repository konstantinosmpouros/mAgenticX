"""Builder "Try it" trials: conversations.is_trial + nullable agent_id

Revision ID: 0043_trial_conversations
Revises: 0042_conversation_files
Create Date: 2026-11-02

Plan 40 lets the agent builder chat with an uncommitted draft. The chat is a
real conversation (the run pipeline needs one) flagged ``is_trial``: always
private, and kept out of every list, the data export and the Usage list.

A draft that was never created has no ``agents`` row, so ``agent_id`` becomes
nullable — but only a trial may leave it empty (CHECK
``ck_conversations_agent_or_trial``). A partial index over the trial rows
serves the sweeper that deletes trials older than a day.

Additive: one column with a safe default, a relaxed NOT NULL, a CHECK and a
partial index. Every existing conversation has an agent and is not a trial,
so nothing to backfill.

Downgrade deletes the trial conversations (ephemeral by design — a Reset
deletes them anyway) after noting their agents-service threads and files in
the reap outbox, so nothing is left behind; then restores NOT NULL.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0043_trial_conversations"
down_revision: Union[str, None] = "0042_conversation_files"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("is_trial", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.alter_column("conversations", "agent_id", existing_type=sa.String(), nullable=True)
    # Hand-written: autogenerate does not see CHECK constraints.
    op.create_check_constraint(
        "ck_conversations_agent_or_trial",
        "conversations",
        "agent_id IS NOT NULL OR is_trial",
    )
    # Hand-written: autogenerate does not see partial-index predicates.
    op.create_index(
        "ix_conversations_trial_created",
        "conversations",
        ["created_at"],
        postgresql_where=sa.text("is_trial"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_trial_created", table_name="conversations")
    op.drop_constraint("ck_conversations_agent_or_trial", "conversations", type_="check")
    op.execute(
        """
        INSERT INTO pending_runtime_reaps (conversation_id, user_id, thread_ids, attempts)
        SELECT c.id,
               c.user_id,
               COALESCE(
                   json_agg(DISTINCT m.checkpoint_thread_id)
                       FILTER (WHERE m.checkpoint_thread_id IS NOT NULL),
                   '[]'::json
               ),
               0
          FROM conversations AS c
          LEFT JOIN messages AS m ON m.conversation_id = c.id
         WHERE c.is_trial
         GROUP BY c.id, c.user_id
        ON CONFLICT (conversation_id) DO NOTHING
        """
    )
    op.execute("DELETE FROM conversations WHERE is_trial")
    op.alter_column("conversations", "agent_id", existing_type=sa.String(), nullable=False)
    op.drop_column("conversations", "is_trial")
