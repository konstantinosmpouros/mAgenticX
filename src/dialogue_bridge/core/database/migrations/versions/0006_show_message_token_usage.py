"""add show_message_token_usage to user_preferences

Revision ID: 0006_show_message_token_usage
Revises: 0005_drop_unused_message_columns
Create Date: 2026-06-19

Adds a per-user boolean preference controlling whether the UI renders per-message
token usage in the AI action bar. Non-destructive: nullable=False with a
server_default of false so existing rows backfill to "off".
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0006_show_message_token_usage"
down_revision: Union[str, None] = "0005_drop_unused_message_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column("show_message_token_usage", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "show_message_token_usage")
