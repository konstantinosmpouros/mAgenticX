"""add user_preferences.use_memory (deep-agent memory toggle)

Revision ID: 0012_use_memory
Revises: 0011_search_past_convs
Create Date: 2026-06-30

Adds the per-user toggle that gates a deep agent's persistent memory (the
AGENT.md `/memories/` mount and the future per-user memory folder). Default
true (on): existing behaviour is preserved — every deep agent gets its
always-on memory unless the user turns it off. The bridge reads this into each
run's config so memory can be disabled per user without an agent code change.

Non-destructive: a single not-null boolean column with a server default; no
backfill needed (server_default 'true' applies to every existing row).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0012_use_memory"
down_revision: Union[str, None] = "0011_search_past_convs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column("use_memory", sa.Boolean(), nullable=False, server_default="true"),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "use_memory")
