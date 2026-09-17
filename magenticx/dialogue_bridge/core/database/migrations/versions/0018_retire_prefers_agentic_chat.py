"""retire the prefers_agentic_chat preference

Revision ID: 0018_retire_prefers_agentic_chat
Revises: 0017_agent_ownership
Create Date: 2026-08-28

``user_preferences.prefers_agentic_chat`` was persisted and returned by the
preferences API since the baseline schema, but nothing ever consumed it: it did
not affect inference routing, agent selection, or UI rendering. It was kept as
forward compatibility for an "autonomous agentic chat mode" toggle that was
never built, and meanwhile surfaced in Settings as a read-only DISABLED chip
that implied a capability the product does not have.

The API field, the Pydantic schema, the frontend type and both settings
surfaces are removed; this drops the column that backed them.

DESTRUCTIVE: the column and its per-user values are removed. This is intentional
and confirmed. The stored value was a no-op boolean with a ``false`` default, so
nothing observable is lost. The downgrade re-creates the column at its default;
it cannot restore per-row values.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0018_retire_prefers_agentic_chat"
down_revision: Union[str, None] = "0017_agent_ownership"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("user_preferences", "prefers_agentic_chat")


def downgrade() -> None:
    # Re-created at the default — the original per-row values are gone.
    op.add_column(
        "user_preferences",
        sa.Column("prefers_agentic_chat", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
