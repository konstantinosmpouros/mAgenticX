"""add scheduled_tasks table + messages.scheduled_task_id tag

Revision ID: 0009_add_scheduled_tasks
Revises: 0008_drop_sessions_table
Create Date: 2026-06-27

Adds the Scheduled Tasks feature storage:

- ``scheduled_tasks`` — a user-owned recurring/one-off agent job. The columns
  describe the *schedule* (cadence, target mode, lifecycle), not a run; a fire
  reuses the normal inference pipeline so its result is a regular AI message.
- ``messages.scheduled_task_id`` — the durable "this run came from task X" tag
  (SET NULL: deleting a task never deletes the runs it produced). This reverse
  link powers the panel's live-status query and per-task run history; Redis only
  carries the live frames and expires them.

Order is deliberate: ``conversations`` already exists (baseline), so the table's
FKs resolve immediately; ``messages.scheduled_task_id``'s FK is added only after
``scheduled_tasks`` exists. No cycle at migration time.

Non-destructive: the new column is nullable with no backfill (all-NULL on
existing rows is correct — no historical message came from a scheduled task).

NOTE: revision id is <= 32 chars (``alembic_version.version_num`` is VARCHAR(32)).
Autogenerate ignores partial indexes (``postgresql_where``) — the due-index DDL
is hand-written here on purpose.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0009_add_scheduled_tasks"
down_revision: Union[str, None] = "0008_drop_sessions_table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "scheduled_tasks",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), nullable=True),
        sa.Column("agent_name", sa.String(), nullable=True),
        sa.Column("agent_slug", sa.String(), nullable=True),
        sa.Column("conversation_id", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("enabled_tools", sa.JSON(), nullable=True),
        sa.Column("is_private", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("target_mode", sa.String(), nullable=False, server_default="fresh"),
        sa.Column("schedule_kind", sa.String(), nullable=False),
        sa.Column("schedule_spec", sa.JSON(), nullable=False),
        sa.Column("timezone", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        sa.Column("next_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_status", sa.String(), nullable=True),
        sa.Column("last_run_message_id", sa.String(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("run_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_runs", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_scheduled_tasks_user_id", "scheduled_tasks", ["user_id"])
    op.create_index("ix_scheduled_tasks_agent_id", "scheduled_tasks", ["agent_id"])
    op.create_index("ix_scheduled_tasks_conversation_id", "scheduled_tasks", ["conversation_id"])
    op.create_index(
        "ix_scheduled_tasks_due",
        "scheduled_tasks",
        ["next_run_at"],
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )

    op.add_column("messages", sa.Column("scheduled_task_id", sa.String(), nullable=True))
    op.create_foreign_key(
        "fk_messages_scheduled_task_id_scheduled_tasks",
        "messages",
        "scheduled_tasks",
        ["scheduled_task_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_messages_scheduled_task_id", "messages", ["scheduled_task_id"])


def downgrade() -> None:
    op.drop_index("ix_messages_scheduled_task_id", table_name="messages")
    op.drop_constraint("fk_messages_scheduled_task_id_scheduled_tasks", "messages", type_="foreignkey")
    op.drop_column("messages", "scheduled_task_id")

    op.drop_index("ix_scheduled_tasks_due", table_name="scheduled_tasks")
    op.drop_index("ix_scheduled_tasks_conversation_id", table_name="scheduled_tasks")
    op.drop_index("ix_scheduled_tasks_agent_id", table_name="scheduled_tasks")
    op.drop_index("ix_scheduled_tasks_user_id", table_name="scheduled_tasks")
    op.drop_table("scheduled_tasks")
