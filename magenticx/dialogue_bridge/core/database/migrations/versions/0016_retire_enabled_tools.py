"""retire the global enabledTools mechanism

Revision ID: 0016_retire_enabled_tools
Revises: 0015_personalization
Create Date: 2026-08-09

Tool selection is now declared per agent (each deep agent's ``agent.yaml``
``tools:`` list, minus a per-(user, agent) disabled set managed in Settings →
Agents). The old *global* tool-enablement model — a client-computed
``enabledTools`` list sent on every inference request, derived from the
``user_preferences.tools.disabled`` set — is retired. This drops the three
columns that stored it:

- ``user_preferences.tools`` — the global disabled-tools preference blob.
- ``messages.streaming_enabled_tools`` — the per-run snapshot of the enabled
  list at stream start.
- ``scheduled_tasks.enabled_tools`` — the per-task frozen tool list a headless
  fire carried.

DESTRUCTIVE: these columns and their contents are removed. This is intentional
and confirmed — the data has no consumer once tools are agent-declared, and the
LangGraph agents (which never bound MCP tools; their retrieval is a graph node)
are unaffected. The downgrade re-creates the columns empty; it cannot restore
the dropped values.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0016_retire_enabled_tools"
down_revision: Union[str, None] = "0015_personalization"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("scheduled_tasks", "enabled_tools")
    op.drop_column("messages", "streaming_enabled_tools")
    op.drop_column("user_preferences", "tools")


def downgrade() -> None:
    # Re-create the columns empty — the original per-row values are gone.
    op.add_column(
        "user_preferences",
        sa.Column("tools", sa.JSON(), nullable=False, server_default="{}"),
    )
    op.add_column("messages", sa.Column("streaming_enabled_tools", sa.JSON(), nullable=True))
    op.add_column("scheduled_tasks", sa.Column("enabled_tools", sa.JSON(), nullable=True))
