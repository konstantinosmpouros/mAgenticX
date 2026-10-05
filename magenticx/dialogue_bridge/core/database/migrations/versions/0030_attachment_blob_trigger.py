"""Delete an attachment's blob whenever the attachment row is deleted

Revision ID: 0030_attachment_blob_trigger
Revises: 0029_account_deletions
Create Date: 2026-10-06

The foreign key runs ``attachments.blob_id → blobs.id``, so ``ON DELETE CASCADE``
reaches attachments when a blob goes — never the other way. Deleting a
conversation cascades to its messages and their attachments, and every blob was
left behind: unreachable bytes in Postgres, and — since nothing points at them —
bytes that deleting the account could not find either.

An ``AFTER DELETE`` trigger on ``attachments`` deletes the row's blob, so every
path that removes an attachment — a cascade from a conversation, a message or a
user, or a direct delete — takes its bytes with it. Attachments and blobs are
one-to-one (a fork copies the bytes into a new blob), so no blob is shared.

Additive: one function and one trigger. Blobs already orphaned are untouched.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0030_attachment_blob_trigger"
down_revision: Union[str, None] = "0029_account_deletions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION delete_attachment_blob() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            DELETE FROM blobs WHERE id = OLD.blob_id;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_attachments_delete_blob
        AFTER DELETE ON attachments
        FOR EACH ROW WHEN (OLD.blob_id IS NOT NULL)
        EXECUTE FUNCTION delete_attachment_blob()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_attachments_delete_blob ON attachments")
    op.execute("DROP FUNCTION IF EXISTS delete_attachment_blob()")
