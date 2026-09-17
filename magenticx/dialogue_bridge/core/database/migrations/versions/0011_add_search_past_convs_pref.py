"""add user_preferences.search_past_convs (memory-tool opt-in)

Revision ID: 0011_search_past_convs
Revises: 0010_message_embeddings
Create Date: 2026-06-30

Adds the per-user opt-in that gates the deep-agent `search_past_conversations`
memory tool. Default false (opt-in): existing users do not get the tool until
they enable it in preferences. The bridge reads this into each run's config so
the agent attaches the tool only when the user has turned it on.

Non-destructive: a single nullable-with-default boolean column; no backfill
needed (server_default 'false' applies to every existing row).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0011_search_past_convs"
down_revision: Union[str, None] = "0010_message_embeddings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column("search_past_convs", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "search_past_convs")
