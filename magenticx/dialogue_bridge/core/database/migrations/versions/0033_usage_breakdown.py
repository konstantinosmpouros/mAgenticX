"""Usage breakdown: message_usage rows, per-answer call counts, conversation totals

Revision ID: 0033_usage_breakdown
Revises: 0032_message_usage_details
Create Date: 2026-10-08

Plan 33 turns the Usage tab into a dashboard you drill into (conversations,
one conversation, agents, one agent). Three additions make every page an index
read instead of a sum over messages:

* ``message_usage`` — one row per (answer, agent scope, agent, model): the main
  agent's and each sub-agent's calls, tokens and model time. Written by
  ``_finish_run`` from now on.
* ``messages.model_calls`` / ``messages.tool_calls`` — how much work an answer
  took, counted from its event log.
* ``conversations.usage_*`` — running totals per conversation, added to by
  ``_finish_run``, indexed for the list's two sorts.

Backfill: the conversation totals are filled from the token columns every
answer already has (one grouped pass), and the last context from the newest
answer that recorded one (0032 onward). Older answers get no ``message_usage``
rows and no call counts — that split was never recorded, and the UI labels the
coverage instead of inventing it (plan 33, decision Q3).

Additive only: one table, nine NOT NULL DEFAULT 0 columns, four nullable ones.
Nothing is deleted.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0033_usage_breakdown"
down_revision: Union[str, None] = "0032_message_usage_details"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ROLLUP_COUNTERS = (
    "usage_answers",
    "usage_input_tokens",
    "usage_cached_tokens",
    "usage_output_tokens",
    "usage_total_tokens",
    "usage_model_calls",
    "usage_tool_calls",
    "usage_model_ms",
)


def upgrade() -> None:
    op.create_table(
        "message_usage",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("message_id", sa.String(), sa.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "conversation_id", sa.String(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", sa.String(), sa.ForeignKey("agents.id", ondelete="SET NULL"), nullable=True),
        sa.Column("main_agent_name", sa.String(), nullable=True),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("agent_name", sa.String(), nullable=False),
        sa.Column("model_name", sa.String(), nullable=True),
        sa.Column("calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reasoning_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("model_latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_message_usage_message_id", "message_usage", ["message_id"])
    op.create_index("ix_message_usage_conversation_id", "message_usage", ["conversation_id"])
    op.create_index("ix_message_usage_user_created", "message_usage", ["user_id", "created_at"])
    op.create_index("ix_message_usage_agent_created", "message_usage", ["agent_id", "created_at"])

    op.add_column("messages", sa.Column("model_calls", sa.Integer(), nullable=True))
    op.add_column("messages", sa.Column("tool_calls", sa.Integer(), nullable=True))

    for name in _ROLLUP_COUNTERS:
        op.add_column("conversations", sa.Column(name, sa.Integer(), nullable=False, server_default="0"))
    op.add_column("conversations", sa.Column("last_context_tokens", sa.Integer(), nullable=True))
    op.add_column("conversations", sa.Column("last_context_window", sa.Integer(), nullable=True))
    op.add_column("conversations", sa.Column("usage_updated_at", sa.DateTime(), nullable=True))
    op.create_index("ix_conversations_user_usage_total", "conversations", ["user_id", "usage_total_tokens"])
    op.create_index("ix_conversations_user_usage_updated", "conversations", ["user_id", "usage_updated_at"])

    # Totals from what every answer already recorded: one grouped pass.
    op.execute(
        """
        UPDATE conversations SET
            usage_answers = agg.answers,
            usage_input_tokens = agg.input_tokens,
            usage_cached_tokens = agg.cached_tokens,
            usage_output_tokens = agg.output_tokens,
            usage_total_tokens = agg.input_tokens + agg.output_tokens,
            usage_model_ms = agg.model_ms,
            usage_updated_at = agg.last_at
        FROM (
            SELECT conversation_id,
                   count(*) AS answers,
                   coalesce(sum(input_tokens), 0) AS input_tokens,
                   coalesce(sum(cached_input_tokens), 0) AS cached_tokens,
                   coalesce(sum(output_tokens), 0) AS output_tokens,
                   coalesce(sum(model_latency_ms), 0) AS model_ms,
                   max(created_at) AS last_at
            FROM messages
            WHERE sender = 'ai' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
            GROUP BY conversation_id
        ) AS agg
        WHERE conversations.id = agg.conversation_id
        """
    )
    # The newest recorded context per conversation (answers from 0032 onward).
    op.execute(
        """
        UPDATE conversations SET
            last_context_tokens = (
                SELECT m.context_tokens FROM messages m
                WHERE m.conversation_id = conversations.id AND m.context_tokens IS NOT NULL
                ORDER BY m.created_at DESC LIMIT 1
            ),
            last_context_window = (
                SELECT m.context_window FROM messages m
                WHERE m.conversation_id = conversations.id AND m.context_tokens IS NOT NULL
                ORDER BY m.created_at DESC LIMIT 1
            )
        WHERE EXISTS (
            SELECT 1 FROM messages m
            WHERE m.conversation_id = conversations.id AND m.context_tokens IS NOT NULL
        )
        """
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_user_usage_updated", table_name="conversations")
    op.drop_index("ix_conversations_user_usage_total", table_name="conversations")
    for name in ("usage_updated_at", "last_context_window", "last_context_tokens", *reversed(_ROLLUP_COUNTERS)):
        op.drop_column("conversations", name)
    op.drop_column("messages", "tool_calls")
    op.drop_column("messages", "model_calls")
    op.drop_table("message_usage")
