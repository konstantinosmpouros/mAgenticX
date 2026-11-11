"""The reasoning effort a user message asked for: messages.effort

Revision ID: 0048_message_effort
Revises: 0047_drop_scheduled_task_private
Create Date: 2026-11-11

The composer lets the user pick how hard a reasoning model thinks on one turn
("minimal" | "low" | "medium" | "high" | "xhigh"). The user message keeps that
choice here so the run context carries it, a retry thinks as hard as the
original, and the composer can show it again after a reload. NULL on every
other message, and on user messages that left the model's default.

Additive only: one nullable column. Nothing to backfill.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0048_message_effort"
down_revision: str | None = "0047_drop_scheduled_task_private"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("effort", sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "effort")
