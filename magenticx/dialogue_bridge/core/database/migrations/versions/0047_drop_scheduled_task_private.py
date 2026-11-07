"""Automations no longer run as private chats: drop scheduled_tasks.is_private.

Revision ID: 0047_drop_scheduled_task_private
Revises: 0046_async_tasks
Create Date: 2026-11-08

A private chat is a one-off: it never shows in the sidebar, search, memory or
suggestions. An automation runs while the user is away to leave them a result,
so a private run hid the very answer it was scheduled to produce. Every run is
now an ordinary conversation, and the flag that chose otherwise is gone.

Existing automations that had it on simply run as ordinary chats from now on.
Their past private runs stay what they were (``conversations.is_private`` is
untouched). Downgrade restores the column with every row ``false``: which
automations had it on is not kept.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0047_drop_scheduled_task_private"
down_revision: str | None = "0046_async_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("scheduled_tasks", "is_private")


def downgrade() -> None:
    op.add_column(
        "scheduled_tasks",
        sa.Column("is_private", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
