"""drop unused message columns: type, plan, subagents

Revision ID: 0005_drop_unused_message_columns
Revises: 0004_add_token_usage_to_messages
Create Date: 2026-06-18

Removes three columns whose stored value nothing consumes:

- ``type`` — message kind enum; never read for any decision or render (the UI
  represents file/image messages via the attachments array, not this column),
  so it carried no signal. Drops the now-orphaned ``message_type_enum`` too.
- ``plan`` / ``subagents`` — fully redundant with ``raw_events``; the UI rebuilds
  both from the PLAN_SNAPSHOT / SUBAGENT_EVENT entries in the event log, and the
  export/share/clone paths carry ``raw_events`` as well.

DESTRUCTIVE: existing ``plan``/``subagents`` JSON (notably on legacy rows that
have empty ``raw_events``) is permanently dropped. It was not rendered anyway —
the legacy timeline fold only uses ``content`` + ``thinking`` — so there is no
visible regression. The downgrade restores the columns/enum but cannot restore
the data.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0005_drop_unused_message_columns"
down_revision: Union[str, None] = "0004_add_token_usage_to_messages"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MESSAGE_TYPE_ENUM = sa.Enum("text", "file", "image", "audio", "tool", name="message_type_enum")


def upgrade() -> None:
    op.drop_column("messages", "plan")
    op.drop_column("messages", "subagents")
    op.drop_column("messages", "type")
    # drop_column removes the column but leaves the now-unused PG enum type behind.
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("DROP TYPE IF EXISTS message_type_enum")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        _MESSAGE_TYPE_ENUM.create(bind, checkfirst=True)
    op.add_column(
        "messages",
        sa.Column("type", _MESSAGE_TYPE_ENUM, nullable=False, server_default="text"),
    )
    op.add_column("messages", sa.Column("subagents", sa.JSON(), nullable=True))
    op.add_column("messages", sa.Column("plan", sa.JSON(), nullable=True))
