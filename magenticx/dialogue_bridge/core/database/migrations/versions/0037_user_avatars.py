"""A photo of the user's own: user_avatars + users.avatar_updated_at

Revision ID: 0037_user_avatars
Revises: 0036_user_preferred_name
Create Date: 2026-10-10

Edit profile lets a user upload a photo. Microsoft sends none, so until now
every avatar was initials. The image (a 256 px WebP the bridge re-encodes) gets
its own table so it never rides along with the users row, which is read on
every request; ON DELETE CASCADE removes it with the account.
users.avatar_updated_at says whether there is one and versions its URL.

Additive only: one new table and one nullable column. Nothing to backfill.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0037_user_avatars"
down_revision: Union[str, None] = "0036_user_preferred_name"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_avatars",
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("mime", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.add_column("users", sa.Column("avatar_updated_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "avatar_updated_at")
    op.drop_table("user_avatars")
