"""Workflow runs: workflow_runs + workflow_run_events

Revision ID: 0044_workflow_runs
Revises: 0043_trial_conversations
Create Date: 2026-11-04

A workflow run is its own entity — not an agent row, not a conversation, not
a message. The workflow definition lives in the agents service; the bridge
keeps the run history the UI shows: one ``workflow_runs`` row per run and
every AG-UI event the engine emitted, in order, in ``workflow_run_events``
(``seq`` assigned by the bridge, the cursor of the run's event stream).

Hand-written: autogenerate does not see partial-index predicates, and the
run list's index is ``created_at DESC``. The unique partial index
``uq_workflow_runs_one_live`` is what makes "one live run per workflow per
user" hold under racing starts.

Additive: two new tables, nothing to backfill. Downgrade drops them — run
history is lost, which is the point of a downgrade past the feature.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0044_workflow_runs"
down_revision: str | None = "0043_trial_conversations"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LIVE = "status IN ('queued', 'running', 'waiting')"


def upgrade() -> None:
    op.create_table(
        "workflow_runs",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("workflow_id", sa.String(), nullable=False),
        sa.Column("workflow_name", sa.String(), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=True),
        sa.Column("trigger_kind", sa.String(), server_default="manual", nullable=False),
        sa.Column("status", sa.String(), server_default="queued", nullable=False),
        sa.Column("inputs", sa.JSON(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("thread_id", sa.String(), nullable=False),
        sa.Column("event_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("started_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_workflow_runs_user_workflow_created",
        "workflow_runs",
        ["user_id", "workflow_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "uq_workflow_runs_one_live",
        "workflow_runs",
        ["user_id", "workflow_id"],
        unique=True,
        postgresql_where=sa.text(_LIVE),
    )
    op.create_index(
        "ix_workflow_runs_live_status",
        "workflow_runs",
        ["status"],
        postgresql_where=sa.text(_LIVE),
    )

    op.create_table(
        "workflow_run_events",
        sa.Column("run_id", sa.String(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("node_id", sa.String(), nullable=True),
        sa.Column("execution_id", sa.String(), nullable=True),
        sa.Column("parent_execution_id", sa.String(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["workflow_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("run_id", "seq", name="pk_workflow_run_events"),
    )
    op.create_index(
        "ix_workflow_run_events_run_execution",
        "workflow_run_events",
        ["run_id", "execution_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_workflow_run_events_run_execution", table_name="workflow_run_events")
    op.drop_table("workflow_run_events")
    op.drop_index("ix_workflow_runs_live_status", table_name="workflow_runs")
    op.drop_index("uq_workflow_runs_one_live", table_name="workflow_runs")
    op.drop_index("ix_workflow_runs_user_workflow_created", table_name="workflow_runs")
    op.drop_table("workflow_runs")
