"""Add the per-user session-revocation watermark.

"Log out of all devices" has nothing to delete: auth is a stateless JWT verified
by signature, so there is no session row per device. Instead every token carries
``iat``, and this column records the instant after which older tokens stop being
accepted — one timestamp retiring every session the user holds.

Nullable with no default on purpose. ``NULL`` means *never revoked*; defaulting
to ``now()`` would silently sign every existing user out on deploy, and
defaulting to the epoch would state something the row does not know.

Purely additive — one nullable column, no backfill, no data loss.

Revision ID: 0026_user_sessions_revoked_at
Revises: 0025_drop_agent_definition_copy
"""
from alembic import op
import sqlalchemy as sa

revision = "0026_user_sessions_revoked_at"
down_revision = "0025_drop_agent_definition_copy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("sessions_revoked_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    """Drop the column.

    Safe as destructive migrations go — losing it re-admits tokens a user
    explicitly revoked, so anyone downgrading with live sessions outstanding
    should treat that as the cost.
    """
    op.drop_column("users", "sessions_revoked_at")
