"""Conversation files in Postgres: stable upload names + the runtime-reap outbox

Revision ID: 0042_conversation_files
Revises: 0041_inference_metrics
Create Date: 2026-10-24

Plan 43 moves a conversation's files off the agents volume. The uploads stay
where they are — here — and the agent reads them through an internal endpoint
instead of a copy on its volume. Two things make that work:

* ``attachments.workspace_name`` — the upload's name in the agent's
  ``/conversation/input/`` folder, assigned once and never changed, so the
  history the agent reads and the file it opens always agree. Uploads also get
  ``content_sha256``, which the agents service checks what it reads against.
* ``pending_runtime_reaps`` — written in the transaction that deletes a
  conversation, removed once the agents service has dropped its threads and
  files, so no delete can leave them behind.

Backfill: every upload gets its hash (computed in Postgres) and a name, per
conversation in upload order — by the rule the agents service used when it
copied uploads onto its volume, so the names it showed before still resolve.
The rule is frozen here on purpose (``utils/workspace_names.py`` is the live
copy): a migration must not change when application code does.

Additive: one column, one table. Downgrade drops both and clears the upload
hashes it added.
"""
from __future__ import annotations

import unicodedata
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0042_conversation_files"
down_revision: str | None = "0041_inference_metrics"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_MAX_NAME_CHARS = 200


def _safe_name(file_name: str) -> str:
    name = unicodedata.normalize("NFC", file_name or "")
    name = "".join("_" if char in "/\\" or not char.isprintable() else char for char in name)
    name = name.strip().lstrip(".").strip() or "file"
    if len(name) <= _MAX_NAME_CHARS:
        return name
    stem, dot, ext = name.rpartition(".")
    if dot and stem and len(ext) < _MAX_NAME_CHARS // 2:
        return f"{stem[:_MAX_NAME_CHARS - len(ext) - 1]}.{ext}"
    return name[:_MAX_NAME_CHARS]


def _assign(taken: dict[str, str | None], file_name: str, sha256: str | None) -> str:
    name = _safe_name(file_name)
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    suffix = f".{ext}" if ext else ""
    candidate, index = name, 0
    while candidate in taken:
        if sha256 is not None and taken[candidate] == sha256:
            return candidate
        index += 1
        candidate = f"{stem}_{index}{suffix}"
    taken[candidate] = sha256
    return candidate


def _backfill_workspace_names() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT m.conversation_id, a.id, a.file_name, a.content_sha256
              FROM attachments AS a
              JOIN messages AS m ON m.id = a.message_id
             WHERE a.origin = 'upload'
             ORDER BY m.conversation_id, m.created_at, a.created_at, a.id
            """
        )
    ).fetchall()
    names: list[dict[str, str]] = []
    taken: dict[str, str | None] = {}
    conversation = None
    for conversation_id, attachment_id, file_name, sha256 in rows:
        if conversation_id != conversation:
            conversation, taken = conversation_id, {}
        names.append({"id": attachment_id, "name": _assign(taken, file_name, sha256)})
    if names:
        bind.execute(sa.text("UPDATE attachments SET workspace_name = :name WHERE id = :id"), names)


def upgrade() -> None:
    op.add_column("attachments", sa.Column("workspace_name", sa.String(), nullable=True))
    op.execute(
        """
        UPDATE attachments AS a
           SET content_sha256 = encode(sha256(b.data), 'hex')
          FROM blobs AS b
         WHERE a.blob_id = b.id
           AND a.origin = 'upload'
           AND a.content_sha256 IS NULL
        """
    )
    _backfill_workspace_names()
    op.create_table(
        "pending_runtime_reaps",
        sa.Column("conversation_id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("thread_ids", sa.JSON(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_pending_runtime_reaps_user_id", "pending_runtime_reaps", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_pending_runtime_reaps_user_id", table_name="pending_runtime_reaps")
    op.drop_table("pending_runtime_reaps")
    op.execute("UPDATE attachments SET content_sha256 = NULL WHERE origin = 'upload'")
    op.drop_column("attachments", "workspace_name")
