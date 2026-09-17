"""add per-message token usage tracking

Revision ID: 0004_add_token_usage_to_messages
Revises: 0003_add_agent_to_messages
Create Date: 2026-06-17

Adds input/output token counts to each AI message. The agents service emits a
TOKEN_USAGE AG-UI event per settled AI message (from ``AIMessage.usage_metadata``);
the bridge sums them across the whole run (all model calls + sub-agents + resume
legs) and writes the totals here. Nullable: user messages and historical AI
messages stay NULL. Collect-only — no backfill, no index (read on hydration,
never filtered on).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0004_add_token_usage_to_messages"
down_revision: Union[str, None] = "0003_add_agent_to_messages"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("input_tokens", sa.Integer(), nullable=True))
    op.add_column("messages", sa.Column("output_tokens", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "output_tokens")
    op.drop_column("messages", "input_tokens")
