"""add attachments.origin/title/summary (agent-generated deliverables)

Revision ID: 0013_attachment_origin
Revises: 0012_use_memory
Create Date: 2026-07-09

Adds provenance + display metadata to attachments so an agent-presented
deliverable (via the deep-agent ``present_artifact`` tool) can be distinguished
from a user upload and carry an agent-supplied title/summary:

- ``origin``  — "upload" (user-attached, the default) | "generated"
                (a present_artifact deliverable). Not-null with a server
                default so every pre-existing row is unambiguously "upload".
- ``title``   — nullable; agent-supplied display title (generated only).
- ``summary`` — nullable; agent-supplied one-line description (generated only).

Non-destructive: ``origin`` is backfilled to "upload" for existing rows before
the not-null constraint is enforced; ``title``/``summary`` are plain nullable
columns. No data is dropped.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0013_attachment_origin"
down_revision: Union[str, None] = "0012_use_memory"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add origin nullable first, backfill existing rows, then enforce not-null +
    # server default so the column is unambiguous for every row (old and new).
    op.add_column("attachments", sa.Column("origin", sa.String(), nullable=True))
    op.execute("UPDATE attachments SET origin = 'upload' WHERE origin IS NULL")
    op.alter_column(
        "attachments",
        "origin",
        existing_type=sa.String(),
        nullable=False,
        server_default="upload",
    )
    op.add_column("attachments", sa.Column("title", sa.String(), nullable=True))
    op.add_column("attachments", sa.Column("summary", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("attachments", "summary")
    op.drop_column("attachments", "title")
    op.drop_column("attachments", "origin")
