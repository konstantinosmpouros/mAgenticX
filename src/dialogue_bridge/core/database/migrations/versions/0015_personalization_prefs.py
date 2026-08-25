"""add user_preferences.personality + custom_instructions

Revision ID: 0015_personalization
Revises: 0014_link_identities
Create Date: 2026-07-15

Adds the two per-user personalization preferences (Settings → Personalization):

- ``personality`` — personality preset id for agent responses. Default
  ``'default'`` = no injected style directive, so existing users keep exactly
  the pre-feature agent voice.
- ``custom_instructions`` — user-authored JSON document ``{enabled, nickname,
  occupation, traits, about}``, injected into deep-agent system prompts only
  while ``enabled`` is true. Default ``'{}'`` = disabled/empty.

Both are threaded by the bridge into each run's ``context.personalization``
and consumed by the agents service (``runtime/personalization.py``).

Non-destructive: two not-null columns with server defaults; no backfill needed
(the defaults apply to every existing row and mean "feature off").
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0015_personalization"
down_revision: Union[str, None] = "0014_link_identities"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column("personality", sa.String(), nullable=False, server_default="default"),
    )
    op.add_column(
        "user_preferences",
        sa.Column("custom_instructions", sa.JSON(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "custom_instructions")
    op.drop_column("user_preferences", "personality")
