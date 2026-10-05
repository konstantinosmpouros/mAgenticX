"""account_deletions: the state and record of each "delete my account" request

Revision ID: 0029_account_deletions
Revises: 0028_export_cooldown_index
Create Date: 2026-10-05

Plan 32, "Delete account". One row per request: requested → (cancelled |
purging → completed). ``step`` is the last purge step that finished, so the
background purger resumes after a crash or redeploy instead of starting over.

The row outlives the user on purpose — it is the proof the deletion happened —
so ``user_id`` is ``ON DELETE SET NULL`` and ``user_ref`` (an HMAC of the id,
not reversible) is what remains. No email, name or content is stored.

Two partial indexes, written by hand because autogenerate ignores ``WHERE``:
one open request per user, and the purger's "due" lookup.

Additive only: one new table, nothing existing touched.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0029_account_deletions"
down_revision: Union[str, None] = "0028_export_cooldown_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OPEN = "cancelled_at IS NULL AND completed_at IS NULL"


def upgrade() -> None:
    op.create_table(
        "account_deletions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_ref", sa.String(), nullable=False),
        sa.Column("requested_at", sa.DateTime(), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(), nullable=False),
        sa.Column("cancelled_at", sa.DateTime(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("step", sa.String(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("last_error_type", sa.String(), nullable=True),
        sa.Column("counts", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index(
        "uq_account_deletions_one_open_per_user",
        "account_deletions",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text(_OPEN),
    )
    op.create_index(
        "ix_account_deletions_due",
        "account_deletions",
        ["scheduled_for"],
        postgresql_where=sa.text(_OPEN),
    )


def downgrade() -> None:
    op.drop_index("ix_account_deletions_due", table_name="account_deletions")
    op.drop_index("uq_account_deletions_one_open_per_user", table_name="account_deletions")
    op.drop_table("account_deletions")
