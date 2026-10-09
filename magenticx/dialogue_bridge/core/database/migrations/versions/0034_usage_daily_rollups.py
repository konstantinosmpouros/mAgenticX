"""Daily usage rollups: usage_daily and usage_daily_groups

Revision ID: 0034_usage_daily_rollups
Revises: 0033_usage_breakdown
Create Date: 2026-10-08

The Usage tab's Overview and Agents pages summed every one of the user's
answers on each load. Messages carry no user_id, so that was a join over
everyone's messages — 0.6–0.8 s for a user with 200k answers in the plan 33
load test, and slower the more the whole platform is used. These two rollups
hold the same sums per user, per UTC day, per agent (and, for the split, per
scope × sub-agent × model), so those pages read a few hundred rows instead.

``_finish_run`` adds each new answer to its day from now on (an upsert, in
the transaction that finalises the answer). This migration backfills both
from what already exists: ``usage_daily`` from the answers' own columns (every
answer that recorded tokens, back to migration 0004), ``usage_daily_groups``
from ``message_usage`` (plan 33 onward — the split was never recorded before).

Additive only: two new tables. Nothing existing is changed or deleted.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0034_usage_daily_rollups"
down_revision: Union[str, None] = "0033_usage_breakdown"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _counter(name: str) -> sa.Column:
    return sa.Column(name, sa.Integer(), nullable=False, server_default="0")


def upgrade() -> None:
    op.create_table(
        "usage_daily",
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("agent_key", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), sa.ForeignKey("agents.id", ondelete="SET NULL"), nullable=True),
        sa.Column("agent_name", sa.String(), nullable=True),
        *(_counter(name) for name in (
            "answers", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens",
            "model_ms", "model_calls", "tool_calls", "detailed_answers", "detailed_input_tokens",
        )),
        sa.PrimaryKeyConstraint("user_id", "day", "agent_key"),
    )
    op.create_table(
        "usage_daily_groups",
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("agent_key", sa.String(), nullable=False),
        sa.Column("agent_id", sa.String(), sa.ForeignKey("agents.id", ondelete="SET NULL"), nullable=True),
        sa.Column("agent_name", sa.String(), nullable=True),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("group_name", sa.String(), nullable=False),
        sa.Column("model_name", sa.String(), nullable=False, server_default=""),
        *(_counter(name) for name in (
            "calls", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "model_ms",
        )),
        sa.PrimaryKeyConstraint("user_id", "day", "agent_key", "scope", "group_name", "model_name"),
    )

    op.execute(
        """
        INSERT INTO usage_daily (
            user_id, day, agent_key, agent_id, agent_name, answers, input_tokens, cached_input_tokens,
            output_tokens, reasoning_tokens, model_ms, model_calls, tool_calls, detailed_answers,
            detailed_input_tokens
        )
        SELECT c.user_id,
               CAST(m.created_at AS DATE),
               coalesce(m.agent_id, 'name:' || coalesce(m.agent_name, 'Unknown agent')),
               max(m.agent_id),
               max(m.agent_name),
               count(*),
               coalesce(sum(m.input_tokens), 0),
               coalesce(sum(m.cached_input_tokens), 0),
               coalesce(sum(m.output_tokens), 0),
               coalesce(sum(m.reasoning_tokens), 0),
               coalesce(sum(m.model_latency_ms), 0),
               coalesce(sum(m.model_calls), 0),
               coalesce(sum(m.tool_calls), 0),
               count(m.model_calls),
               coalesce(sum(CASE WHEN m.model_calls IS NOT NULL THEN m.input_tokens ELSE 0 END), 0)
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.sender = 'ai' AND (m.input_tokens IS NOT NULL OR m.output_tokens IS NOT NULL)
        GROUP BY c.user_id, CAST(m.created_at AS DATE),
                 coalesce(m.agent_id, 'name:' || coalesce(m.agent_name, 'Unknown agent'))
        """
    )
    op.execute(
        """
        INSERT INTO usage_daily_groups (
            user_id, day, agent_key, agent_id, agent_name, scope, group_name, model_name, calls,
            input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, model_ms
        )
        SELECT user_id,
               CAST(created_at AS DATE),
               coalesce(agent_id, 'name:' || coalesce(main_agent_name, 'Unknown agent')),
               max(agent_id),
               max(main_agent_name),
               scope,
               agent_name,
               coalesce(model_name, ''),
               sum(calls), sum(input_tokens), sum(cached_input_tokens), sum(output_tokens),
               sum(reasoning_tokens), sum(model_latency_ms)
        FROM message_usage
        GROUP BY user_id, CAST(created_at AS DATE),
                 coalesce(agent_id, 'name:' || coalesce(main_agent_name, 'Unknown agent')),
                 scope, agent_name, coalesce(model_name, '')
        """
    )


def downgrade() -> None:
    op.drop_table("usage_daily_groups")
    op.drop_table("usage_daily")
