"""The slash command a user message ran: messages.command

Revision ID: 0040_message_command
Revises: 0039_generated_file_capture
Create Date: 2026-10-10

Plan 35: a user message can run a slash command (`/explain the retry loop`).
The message keeps what the user typed as its content and records the command
here, {"name": "explain"}, so the bubble shows it as a chip after a reload and a
retry runs the same command again. NULL on every other message.

Additive only: one nullable column. Nothing to backfill.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0040_message_command"
down_revision: Union[str, None] = "0039_generated_file_capture"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("command", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "command")
