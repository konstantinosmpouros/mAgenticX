"""Workflow schedules: workflow_schedules

Revision ID: 0045_workflow_schedules
Revises: 0044_workflow_runs
Create Date: 2026-11-04

A workflow is scheduled by its start node (``trigger.schedule`` in the spec,
plan 38 §3.9). The spec is the source of truth; this table is its
materialisation, one row per scheduled workflow, written by the definitions
proxy on every save and polled by the scheduler. Its own table rather than
``scheduled_tasks`` rows, so the Automations → Schedules list never mixes
agent schedules with workflow schedules.

Hand-written: autogenerate does not see the partial-index predicate of
``ix_workflow_schedules_due`` (the scheduler's hot poll over active rows).

Additive: one new table, nothing to backfill — existing workflows have only
manual triggers. Downgrade drops it; the specs still hold every schedule, so a
re-save after upgrading again restores them.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0045_workflow_schedules"
down_revision: str | None = "0044_workflow_runs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workflow_schedules",
        sa.Column("workflow_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("node_id", sa.String(), nullable=False),
        sa.Column("schedule_kind", sa.String(), nullable=False),
        sa.Column("schedule_spec", sa.JSON(), nullable=False),
        sa.Column("timezone", sa.String(), nullable=True),
        sa.Column("inputs", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(), server_default="active", nullable=False),
        sa.Column("next_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_id", sa.String(), nullable=True),
        sa.Column("last_run_status", sa.String(), nullable=True),
        sa.Column("run_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("workflow_id"),
    )
    op.create_index("ix_workflow_schedules_user_id", "workflow_schedules", ["user_id"])
    op.create_index(
        "ix_workflow_schedules_due",
        "workflow_schedules",
        ["next_run_at"],
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index("ix_workflow_schedules_due", table_name="workflow_schedules")
    op.drop_index("ix_workflow_schedules_user_id", table_name="workflow_schedules")
    op.drop_table("workflow_schedules")
