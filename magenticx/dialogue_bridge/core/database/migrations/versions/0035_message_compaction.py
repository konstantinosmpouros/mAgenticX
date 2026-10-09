"""Manual compaction recorded on the answer it follows: messages.compaction

Revision ID: 0035_message_compaction
Revises: 0034_usage_daily_rollups
Create Date: 2026-10-08

Plan 34 lets a user compact a conversation from the composer's context ring.
The compaction happens between turns, after an answer, so it is recorded on
that answer: what it freed, the summary, the summary call's spend and, if it
was taken back, when. The UI draws the "Compacted" divider under the answer
from it. NULL everywhere else — nothing to backfill.

Additive only: one nullable column. Nothing existing is changed or deleted.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0035_message_compaction"
down_revision: Union[str, None] = "0034_usage_daily_rollups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("compaction", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "compaction")
