"""Inference metrics: cost, truncation, time to first token, speed, tool usage

Revision ID: 0041_inference_metrics
Revises: 0040_message_command
Create Date: 2026-10-23

Plan 41 records four more things about every answer, from what the agents
service already reports per model call (``TOKEN_USAGE``) and per tool call
(the new ``TOOL_USAGE`` event):

* **Cost** — priced by the bridge from ``utils/model_pricing.py`` at the
  moment the answer finishes, in micro-USD (``BIGINT``; 1 USD = 1,000,000). A
  call on a model with no price adds to ``unpriced_calls`` instead, so a total
  is never shown as complete when it is not.
* **Truncation** — calls that stopped at the output-token limit.
* **Speed** — time to first token per call (``ttft_ms`` / ``ttft_calls``),
  generation time after it (``gen_ms``) and the output tokens it produced
  (``gen_output_tokens``): tokens per second = gen_output_tokens / gen_ms.
  And the answer's own ``first_token_ms``: from the run's start to its first
  text, as the user waited for it.
* **Tools** — ``tool_usage``, one row per (answer, scope, agent, tool), and its
  daily rollup ``tool_usage_daily`` (the same upsert-add as ``usage_daily``).

Every counter goes where the token counters already are: the answer, its
``message_usage`` split, the conversation's running totals and the daily
rollups. The answer's columns are nullable, NULL when it spent nothing, like
its token columns; every other counter is NOT NULL DEFAULT 0.

No backfill: older answers were never measured this way. Each average divides
by its own denominator (``first_token_answers``, ``ttft_calls``, ``gen_ms``),
so the zeros of older rows never drag one down.

Additive only: two new tables, columns with defaults. Nothing is deleted.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0041_inference_metrics"
down_revision: str | None = "0040_message_command"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The answer's own figures: nullable, NULL on an answer that spent nothing.
_MESSAGE_COLUMNS = (
    "unpriced_calls", "truncated_calls", "first_token_ms", "ttft_ms", "ttft_calls", "gen_ms", "gen_output_tokens",
)
# The per-group split, on message_usage and usage_daily_groups alike.
_GROUP_COUNTERS = ("unpriced_calls", "truncated_calls", "ttft_ms", "ttft_calls", "gen_ms", "gen_output_tokens")
_DAILY_COUNTERS = ("unpriced_calls", "truncated_calls", "first_token_ms", "first_token_answers")
_TOOL_COUNTERS = ("calls", "errors", "duration_ms", "output_chars")


def _counter(name: str) -> sa.Column:
    return sa.Column(name, sa.Integer(), nullable=False, server_default="0")


def _money(name: str) -> sa.Column:
    return sa.Column(name, sa.BigInteger(), nullable=False, server_default="0")


def upgrade() -> None:
    op.add_column("messages", sa.Column("cost_micros", sa.BigInteger(), nullable=True))
    for name in _MESSAGE_COLUMNS:
        op.add_column("messages", sa.Column(name, sa.Integer(), nullable=True))

    for table in ("message_usage", "usage_daily_groups"):
        op.add_column(table, _money("cost_micros"))
        for name in _GROUP_COUNTERS:
            op.add_column(table, _counter(name))

    op.add_column("conversations", _money("usage_cost_micros"))
    op.add_column("conversations", _counter("usage_truncated_calls"))

    op.add_column("usage_daily", _money("cost_micros"))
    for name in _DAILY_COUNTERS:
        op.add_column("usage_daily", _counter(name))

    op.create_table(
        "tool_usage",
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
        sa.Column("tool_name", sa.String(), nullable=False),
        *(_counter(name) for name in _TOOL_COUNTERS),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_tool_usage_user_created", "tool_usage", ["user_id", "created_at"])
    op.create_index("ix_tool_usage_conversation_id", "tool_usage", ["conversation_id"])
    op.create_index("ix_tool_usage_message_id", "tool_usage", ["message_id"])

    op.create_table(
        "tool_usage_daily",
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("agent_key", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), sa.ForeignKey("agents.id", ondelete="SET NULL"), nullable=True),
        sa.Column("agent_name", sa.String(), nullable=True),
        sa.Column("tool_name", sa.String(), nullable=False),
        *(_counter(name) for name in _TOOL_COUNTERS),
        sa.PrimaryKeyConstraint("user_id", "day", "agent_key", "tool_name"),
    )


def downgrade() -> None:
    op.drop_table("tool_usage_daily")
    op.drop_index("ix_tool_usage_message_id", table_name="tool_usage")
    op.drop_index("ix_tool_usage_conversation_id", table_name="tool_usage")
    op.drop_index("ix_tool_usage_user_created", table_name="tool_usage")
    op.drop_table("tool_usage")

    for name in (*reversed(_DAILY_COUNTERS), "cost_micros"):
        op.drop_column("usage_daily", name)
    op.drop_column("conversations", "usage_truncated_calls")
    op.drop_column("conversations", "usage_cost_micros")
    for table in ("usage_daily_groups", "message_usage"):
        for name in (*reversed(_GROUP_COUNTERS), "cost_micros"):
            op.drop_column(table, name)
    for name in (*reversed(_MESSAGE_COLUMNS), "cost_micros"):
        op.drop_column("messages", name)
