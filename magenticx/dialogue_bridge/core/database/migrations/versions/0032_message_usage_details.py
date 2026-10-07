"""messages: the rest of a run's usage — cached/reasoning tokens, model time, context

Revision ID: 0032_message_usage_details
Revises: 0031_message_embedding_checked
Create Date: 2026-10-07

The agents service's ``UsageMetricsMiddleware`` now reports, per model call,
which model ran, how long it took and how full its context window was; the
``TOKEN_USAGE`` event already carried cached and reasoning token details. Until
now the bridge kept only input and output totals.

Summed over the run: ``cached_input_tokens``, ``reasoning_tokens``,
``model_latency_ms``. The main agent's context on its last call — what the
UI's context gauge shows: ``context_tokens`` of ``context_window``,
``compaction_percent`` (where the summarizer compacts) and ``model_name``.

Additive only: seven nullable columns, NULL on every existing row.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0032_message_usage_details"
down_revision: Union[str, None] = "0031_message_embedding_checked"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("cached_input_tokens", sa.Integer()),
    ("reasoning_tokens", sa.Integer()),
    ("model_latency_ms", sa.Integer()),
    ("context_tokens", sa.Integer()),
    ("context_window", sa.Integer()),
    ("compaction_percent", sa.Float()),
    ("model_name", sa.String()),
)


def upgrade() -> None:
    for name, type_ in _COLUMNS:
        op.add_column("messages", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        op.drop_column("messages", name)
