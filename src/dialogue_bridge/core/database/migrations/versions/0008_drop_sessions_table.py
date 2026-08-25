"""drop the sessions table — auth is now stateless Vault-signed JWTs

Revision ID: 0008_drop_sessions_table
Revises: 0007_checkpoint_lineage
Create Date: 2026-06-25

The bridge no longer stores server-side sessions: it issues stateless RS256
JWTs signed by Vault Transit and verifies them by signature (plus a Redis
logout denylist). The ``sessions`` table only ever held ephemeral session rows
(token hashes + expiries), never user content — dropping it loses nothing
recoverable. Existing cookies are opaque to the new code, so users re-authenticate.

Reversible: ``downgrade`` recreates the table + indexes exactly as the baseline
defined them (empty — prior session rows are gone).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0008_drop_sessions_table"
down_revision: Union[str, None] = "0007_checkpoint_lineage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("ix_sessions_prev_refresh_token_hash", table_name="sessions")
    op.drop_index("ix_sessions_refresh_token_hash", table_name="sessions")
    op.drop_index("ix_sessions_access_token_hash", table_name="sessions")
    op.drop_index("ix_sessions_user_id", table_name="sessions")
    op.drop_table("sessions")


def downgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("access_token_hash", sa.String(), nullable=False),
        sa.Column("refresh_token_hash", sa.String(), nullable=False),
        sa.Column("prev_refresh_token_hash", sa.String(), nullable=True),
        sa.Column("access_expires_at", sa.DateTime(), nullable=False),
        sa.Column("refresh_expires_at", sa.DateTime(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("user_agent_hash", sa.String(), nullable=True),
        sa.Column("ip_hash", sa.String(), nullable=True),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("last_refreshed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("access_token_hash", name="uq_sessions_access_token_hash"),
        sa.UniqueConstraint("refresh_token_hash", name="uq_sessions_refresh_token_hash"),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_index("ix_sessions_access_token_hash", "sessions", ["access_token_hash"])
    op.create_index("ix_sessions_refresh_token_hash", "sessions", ["refresh_token_hash"])
    op.create_index("ix_sessions_prev_refresh_token_hash", "sessions", ["prev_refresh_token_hash"])
