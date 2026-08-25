"""add `type` column to agents

Revision ID: 0002_add_agent_type
Revises: 0001_baseline
Create Date: 2026-06-08

Adds the agent lifecycle type ("deep agent", "langgraph agent", etc.) that the
agents-service manifest has always carried. Storing it on the bridge side lets
the UI filter to features only a subset of agents support — e.g. the per-user
skill selection UI in Phase 2 of the Skills feature renders only for deep
agents.

The default ``langgraph agent`` is safe for existing rows: most catalogue
agents are LangGraph, and the next ``sync_agents_with_service`` cycle will
overwrite every row with the live manifest value.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0002_add_agent_type"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column(
            "type",
            sa.String(),
            nullable=False,
            server_default="langgraph agent",
        ),
    )


def downgrade() -> None:
    op.drop_column("agents", "type")
