"""Tombstone column for user skill pool entries.

Removing a skill deletes it from the agents-service volume first, then from
``chat_db``. If the second half fails, the volume no longer has the skill but
``chat_db`` still lists it — and a reconciliation pass reading that state cannot
tell it apart from *the volume lost the skill and needs it written back*. Acting
on the wrong reading silently resurrects skills the user deleted.

``deleted_at`` disambiguates it: a row carrying one is a removal still in
flight, so the pass finishes the deletion instead of undoing it. Custom agents
already had this property via ``agents.is_active`` (a soft delete kept for the
``conversations`` cascade); pool entries had no equivalent.

Additive only — one nullable column, no backfill. Every existing row is live,
which is exactly what ``NULL`` means here.

Revision ID: 0020_skill_pool_tombstone

The id is deliberately short: ``alembic_version.version_num`` is varchar(32),
so a longer slug fails the version bump *after* the DDL has run.
Revises: 0019_persist_user_content
"""

from alembic import op
import sqlalchemy as sa

revision = "0020_skill_pool_tombstone"
down_revision = "0019_persist_user_content"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_skill_pool",
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    # Dropping the column loses in-flight removals: any row carrying a tombstone
    # reverts to looking live, and the next reconciliation writes the skill back
    # to the volume. Harmless on a pool with no pending deletions, which is the
    # normal state.
    op.drop_column("user_skill_pool", "deleted_at")
