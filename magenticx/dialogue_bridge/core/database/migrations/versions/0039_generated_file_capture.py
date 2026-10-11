"""Every file an agent writes is stored: attachments.content_sha256 + presented

Revision ID: 0039_generated_file_capture
Revises: 0038_conversation_pins
Create Date: 2026-10-10

Until now only files the agent *presented* were stored; the rest lived on the
agents volume until its TTL sweep deleted them. Plan 35 phase 0 stores every
file the agent wrote, at the end of every run. To store an unchanged file only
once, the bridge compares hashes with what the conversation already holds, so
each generated attachment records the SHA-256 of its bytes. And because a file
that was only written — never shown — must stay private to its owner, share
links and the PDF export carry only uploads and *presented* files: `presented`
says which.

Additive: two columns. Backfill: the generated attachments that already exist
get their hash (computed in Postgres) and `presented = true` — before this
change only presented files were ever stored. Uploads keep NULL / false.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0039_generated_file_capture"
down_revision: Union[str, None] = "0038_conversation_pins"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("attachments", sa.Column("content_sha256", sa.String(length=64), nullable=True))
    op.add_column(
        "attachments", sa.Column("presented", sa.Boolean(), nullable=False, server_default=sa.text("false"))
    )
    op.execute(
        """
        UPDATE attachments AS a
           SET content_sha256 = encode(sha256(b.data), 'hex'),
               presented = true
          FROM blobs AS b
         WHERE a.blob_id = b.id
           AND a.origin = 'generated'
        """
    )


def downgrade() -> None:
    op.drop_column("attachments", "presented")
    op.drop_column("attachments", "content_sha256")
