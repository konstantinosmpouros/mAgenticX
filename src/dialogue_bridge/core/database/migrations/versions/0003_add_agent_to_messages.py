"""add per-message agent attribution

Revision ID: 0003_add_agent_to_messages
Revises: 0002_add_agent_type
Create Date: 2026-06-10

Moves agent attribution from conversation-scoped to message-scoped. Each AI
message records the agent that produced it (`agent_id` + denormalized
`agent_name`), and `conversations.agent_id` becomes a "last-used" pointer. This
lets a user switch agents mid-conversation: the next message goes to the new
agent in the same thread, while each message keeps showing the agent that
actually answered it.

Backfill: existing AI messages inherit their conversation's current agent so
historical threads render unchanged. User messages stay NULL.

`ondelete=SET NULL` (conversations use CASCADE) so deleting an agent never
deletes message history — `agent_name` preserves the label for display.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0003_add_agent_to_messages"
down_revision: Union[str, None] = "0002_add_agent_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("agent_id", sa.String(), nullable=True))
    op.add_column("messages", sa.Column("agent_name", sa.String(), nullable=True))

    # Backfill AI messages from their conversation's current agent so existing
    # threads keep their attribution. User messages remain NULL.
    op.execute(
        """
        UPDATE messages
        SET agent_id = c.agent_id,
            agent_name = c.agent_name
        FROM conversations c
        WHERE messages.conversation_id = c.id
          AND messages.sender = 'ai'
        """
    )

    op.create_index("ix_messages_agent_id", "messages", ["agent_id"])
    op.create_foreign_key(
        "fk_messages_agent_id_agents",
        "messages",
        "agents",
        ["agent_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_messages_agent_id_agents", "messages", type_="foreignkey")
    op.drop_index("ix_messages_agent_id", table_name="messages")
    op.drop_column("messages", "agent_name")
    op.drop_column("messages", "agent_id")
