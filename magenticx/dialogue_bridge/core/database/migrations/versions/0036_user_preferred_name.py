"""The name a user picks in Edit profile: users.preferred_name

Revision ID: 0036_user_preferred_name
Revises: 0035_message_compaction
Create Date: 2026-10-10

Edit profile lets a user change the name the app shows. It cannot live in
users.display_name: every Microsoft sign-in rewrites that column from the
token's `name` claim, so the change would be lost on the next login. NULL means
"use Microsoft's name" — every existing row, so nothing to backfill.

Additive only: one nullable column. Nothing existing is changed or deleted.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0036_user_preferred_name"
down_revision: Union[str, None] = "0035_message_compaction"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("preferred_name", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "preferred_name")
