"""Async sub-agents (plan 41): conversation_tasks, messages.kind/task_notice,
conversations.queued_message, and the task -> start_async_task tool rename.

Revision ID: 0046_async_tasks
Revises: 0045_workflow_schedules
Create Date: 2026-11-06

Every sub-agent now runs as a background task in the agents service. The
bridge keeps what the UI needs about them:

* ``conversation_tasks`` — the mirror of each task (plan 41 §4, §14.1), fed
  from the ``tasks:status`` Redis stream. It cascades with its conversation
  and its user, and is included in the export and the delete-account purge.
* ``messages.kind`` (enum ``message_kind_enum``: ``task_notification``) and
  ``messages.task_notice`` — the wake-up input row: sender ``user`` because
  the orchestrator receives it as a HumanMessage, rendered by the UI as a
  compact notice. NULL on every existing message.
* ``conversations.queued_message`` — the composer's one queued message.

Data: a user's per-agent override for the retired blocking ``task`` tool
becomes an override for ``start_async_task``, the gate that replaces it
(plan 41 §3.8). Where the user already has a ``start_async_task`` row for the
same agent, that newer choice wins and the legacy ``task`` row is left as it
is — nothing is deleted. The agents service ignores an override for a tool it
no longer builds.

Hand-written: the Postgres enum type must be created before the column that
uses it, which autogenerate does not do for ``add_column``. Additive only:
downgrade drops what upgrade added and renames the overrides back where that
cannot collide.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0046_async_tasks"
down_revision: str | None = "0045_workflow_schedules"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KIND_ENUM = "message_kind_enum"
_JSONB = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        postgresql.ENUM("task_notification", name=_KIND_ENUM).create(bind, checkfirst=True)
        kind_type: sa.types.TypeEngine = postgresql.ENUM("task_notification", name=_KIND_ENUM, create_type=False)
    else:
        kind_type = sa.Enum("task_notification", name=_KIND_ENUM)

    op.add_column("messages", sa.Column("kind", kind_type, nullable=True))
    op.add_column("messages", sa.Column("task_notice", _JSONB, nullable=True))
    op.add_column("conversations", sa.Column("queued_message", _JSONB, nullable=True))

    op.create_table(
        "conversation_tasks",
        sa.Column("task_id", sa.String(), nullable=False),
        sa.Column("conversation_id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("parent_task_id", sa.String(), nullable=True),
        sa.Column("root_run_id", sa.String(), nullable=True),
        sa.Column("branch_thread_id", sa.String(), nullable=True),
        sa.Column("spawned_by_message_id", sa.String(), nullable=True),
        sa.Column("depth", sa.Integer(), server_default="1", nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("subagent_path", sa.String(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("result_preview", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("usage", _JSONB, nullable=True),
        sa.Column("usage_booked", _JSONB, nullable=True),
        sa.Column("raw_events", _JSONB, nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("settled_at", sa.DateTime(), nullable=True),
        sa.Column("notified_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("task_id"),
    )
    op.create_index("ix_conversation_tasks_conversation_id", "conversation_tasks", ["conversation_id"])
    op.create_index("ix_conversation_tasks_parent_task_id", "conversation_tasks", ["parent_task_id"])
    op.create_index("ix_conversation_tasks_user_id", "conversation_tasks", ["user_id"])

    # The gate that replaces `task`. Skips the (user, agent) pairs that already
    # chose for start_async_task, so the unique key can never collide.
    op.execute(
        sa.text(
            "UPDATE user_agent_tool_prefs AS p SET tool_key = 'start_async_task' "
            "WHERE p.tool_key = 'task' AND NOT EXISTS ("
            "SELECT 1 FROM user_agent_tool_prefs AS q "
            "WHERE q.user_id = p.user_id AND q.agent_slug = p.agent_slug "
            "AND q.tool_key = 'start_async_task')"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE user_agent_tool_prefs AS p SET tool_key = 'task' "
            "WHERE p.tool_key = 'start_async_task' AND NOT EXISTS ("
            "SELECT 1 FROM user_agent_tool_prefs AS q "
            "WHERE q.user_id = p.user_id AND q.agent_slug = p.agent_slug "
            "AND q.tool_key = 'task')"
        )
    )
    op.drop_index("ix_conversation_tasks_user_id", table_name="conversation_tasks")
    op.drop_index("ix_conversation_tasks_parent_task_id", table_name="conversation_tasks")
    op.drop_index("ix_conversation_tasks_conversation_id", table_name="conversation_tasks")
    op.drop_table("conversation_tasks")
    op.drop_column("conversations", "queued_message")
    op.drop_column("messages", "task_notice")
    op.drop_column("messages", "kind")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        postgresql.ENUM(name=_KIND_ENUM).drop(bind, checkfirst=True)
