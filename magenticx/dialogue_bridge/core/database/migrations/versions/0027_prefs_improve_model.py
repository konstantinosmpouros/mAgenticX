"""add improve_model to user_preferences

Revision ID: 0027_prefs_improve_model
Revises: 0026_user_sessions_revoked_at
Create Date: 2026-10-03

Adds the per-user "Improve the model for everyone" choice (Settings → Data
controls): whether the user allows their conversations to be used to improve
future models. Stored only — nothing reads it yet.

Opt-in: nullable=False with a server_default of false, so every existing user
backfills to "not allowed". Additive and non-destructive.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0027_prefs_improve_model"
down_revision: Union[str, None] = "0026_user_sessions_revoked_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column("improve_model", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "improve_model")
