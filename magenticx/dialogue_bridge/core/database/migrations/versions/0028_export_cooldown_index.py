"""users.last_export_at + an ordered index for paging messages (data export)

Revision ID: 0028_export_cooldown_index
Revises: 0027_prefs_improve_model
Create Date: 2026-10-04

Plan 27, "Export my data":

* ``users.last_export_at`` — nullable; when the user last started an export.
  The one-per-hour cooldown is enforced against it (durable, so it holds even
  when Redis — and with it rate limiting — is down). NULL = never exported.
* ``ix_messages_conversation_id_id`` on ``messages(conversation_id, id)`` — the
  export pages each conversation's messages by keyset on ``id``; with this index
  every page is an ordered range scan, no sort, nothing spilled to a Postgres
  temp file. (``id`` rather than ``created_at``: ids compare exactly in every
  database, while a timestamp can be stored at a different precision than it is
  bound at, which skips rows at page boundaries.)

Additive only: one nullable column, one index, no data rewritten.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0028_export_cooldown_index"
down_revision: Union[str, None] = "0027_prefs_improve_model"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_export_at", sa.DateTime(), nullable=True))
    op.create_index(
        "ix_messages_conversation_id_id",
        "messages",
        ["conversation_id", "id"],
    )


def downgrade() -> None:
    op.drop_index("ix_messages_conversation_id_id", table_name="messages")
    op.drop_column("users", "last_export_at")
